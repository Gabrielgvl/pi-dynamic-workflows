import { createHash, randomUUID } from "node:crypto";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { boundWorktreeCleanupFailure, MAX_WORKTREE_CLEANUP_FAILURES } from "./run-persistence.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import {
  type BudgetExhaustion,
  mergeTokenUsage,
  type RuntimeCheckpoint,
  restoreTokenUsage,
  type TokenUsage,
  UsageController,
  type UsageSample,
} from "./usage.js";
import {
  DEFAULT_WORKTREE_OPERATIONS,
  type RetainedWorktreeLease,
  RetainedWorktreeRegistry,
  type RetainedWorktreeResult,
  type Worktree,
  type WorktreeCleanupFailure,
  type WorktreeHandle,
  type WorktreeOperations,
} from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

/** One cached call result, keyed by its stable hierarchical call key. */
export interface JournalEntry {
  /** Legacy numeric identity retained for schema-less run compatibility. */
  index: number;
  /** Stable identity across parent, sibling nested, and child workflow scopes. */
  key?: string;
  kind?: "agent" | "checkpoint" | "workflow";
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /** Cumulative usage for all attempts of this logical call. */
  usage?: TokenUsage;
  /** Compatibility/display total for all attempts of this logical call. */
  tokens?: number;
  /** Logical agents represented by a nested workflow result. */
  agentCount?: number;
  /** Exact stable descendant agent identities represented by this completed wrapper generation. */
  descendantAgentAccountingCallKeys?: string[];
  /** Stable accounting identity for this call's workflow invocation. */
  accountingScopeKey?: string;
  /** Stable logical call identity within accountingScopeKey, independent of wrapper position. */
  accountingCallKey?: string;
  /**
   * Per-agent write delta (keys set by this agent) for additive replay on resume.
   * Replaces the former full-map snapshot. Internal storeDeltaSequences metadata
   * preserves actual relative write order when parallel calls replay lexically.
   * Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
  /** Internal original write-order metadata; storeDelta retains its public shape. */
  storeDeltaSequences?: Record<string, number>;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  /** @deprecated Use the run result/checkpoint usage total. Retained for compatibility. */
  spent: number;
  /** @deprecated Use the run result/checkpoint token usage. Retained for compatibility. */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** @deprecated Nesting is now immutable per invocation. Retained for compatibility. */
  depth: number;
  /** Internal cumulative usage controller, added lazily for legacy runtimes. */
  usage?: UsageController;
  /** Internal ownership registry shared by the top-level run and nested workflows. */
  liveInvocations?: Set<Promise<unknown>>;
  /** Internal operations grouped by the invocation that owns their lifetime. */
  liveOperationsByScope?: Map<string, Set<Promise<unknown>>>;
  /** @deprecated Root-scoped ownership is carried by a separate execution context. */
  retainedWorktrees?: RetainedWorktreeRegistry;
}

interface ActiveSharedRuntime extends SharedRuntime {
  usage: UsageController;
  tokenUsage: TokenUsage;
  liveInvocations: Set<Promise<unknown>>;
  liveOperationsByScope: Map<string, Set<Promise<unknown>>>;
}

interface CleanupFailureCollectionResult {
  /** Immutable detached value admitted to the canonical bounded root collection. */
  admittedFailure?: WorktreeCleanupFailure;
  /** Bounded diagnostic produced when the external callback itself throws. */
  callbackFailure?: WorktreeCleanupFailure;
}

interface RootOperationAdmission {
  readonly owner: symbol;
}

interface RootExecutionContext {
  retainedWorktrees: RetainedWorktreeRegistry;
  admitOperation(parent?: RootOperationAdmission): RootOperationAdmission;
  completeOperationAdmission(admission: RootOperationAdmission): void;
  closeOperationAdmission(): void;
  retainedWorktreeUseScopes: Set<string>;
  /** Bounded diagnostics accumulated across ordinary, explicit-release, and terminal cleanup. */
  worktreeCleanupFailures: WorktreeCleanupFailure[];
  /** Deduplicated root collection plus the single external callback dispatch point. */
  reportWorktreeCleanupFailure(failure: WorktreeCleanupFailure): CleanupFailureCollectionResult;
  /** Ordinary failed cleanups whose proof authority ends at root terminal settlement. */
  terminalProofWorktrees: Set<Worktree>;
  /** Failed creation rollbacks that receive one root-owned terminal cleanup retry. */
  terminalRetryWorktrees: Set<Worktree>;
  /** Operations owned by this root, including nested workflows and retained consumers. */
  liveOperations: Set<Promise<unknown>>;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) +
   * `~/.pi/agent/agents` (user, primary) + `~/.pi/agents` (user, deprecated
   * fallback). Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  /** Persisted cumulative usage from earlier generations of this run. */
  initialTokenUsage?: Partial<SharedRuntime["tokenUsage"]>;
  /** Persisted cumulative budget spend; defaults to initialTokenUsage.total. */
  initialTokenSpend?: number;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Resume: cached results keyed by hierarchical key (or legacy numeric index). */
  resumeJournal?: Map<string | number, JournalEntry>;
  /** Resume: versioned cumulative accounting and phase-budget state. */
  runtimeCheckpoint?: RuntimeCheckpoint;
  /** Called whenever attempt state or cumulative usage changes. */
  onRuntimeCheckpoint?: (checkpoint: RuntimeCheckpoint) => void;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal/injectable worktree operations (primarily for deterministic tests). */
  worktreeOperations?: WorktreeOperations;
  /** Receives best-effort retained-worktree cleanup diagnostics. */
  onWorktreeCleanupFailure?: (failure: WorktreeCleanupFailure) => void | PromiseLike<void>;
  /** Internal: observes entries actually replayed inside a nested invocation. */
  onJournalReplay?: (entry: JournalEntry) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /** Internal: per-root ownership inherited only by nested workflow() calls. */
  executionContext?: RootExecutionContext;
  /** Internal: live admission inherited by one already-admitted nested wrapper. */
  operationAdmission?: RootOperationAdmission;
  /** Internal positional scope for hierarchical journal keys. */
  scopeKey?: string;
  /** Internal stable scope for usage and phase ownership, independent of execution position. */
  accountingScopeKey?: string;
  /** @deprecated Internal compatibility alias for accountingScopeKey. */
  phaseScopeKey?: string;
  /** Internal unique invocation scope for descendant operation drain only. */
  operationScopeKey?: string;
  /** Internal immutable nesting level (0 = top-level, 1 = child). */
  nestingDepth?: number;
  /**
   * Shared store for this run. One instance is created per top-level run and
   * propagated into nested workflow() calls. Pass an existing instance to share
   * state across a parent and child run; omit to create a fresh isolated store.
   */
  sharedStore?: SharedStore;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    key?: string;
    accountingCallKey?: string;
    replayed?: boolean;
  }) => void;
  onAgentEnd?: (event: {
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    tokenUsage?: AgentUsage;
    worktree?: string;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    key?: string;
    accountingCallKey?: string;
    replayed?: boolean;
  }) => void;
  onAgentHistory?: (event: {
    label: string;
    phase?: string;
    history: AgentHistoryEntry[];
    key?: string;
    accountingCallKey?: string;
  }) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
}

export interface WorkflowTokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead?: number;
  cacheWrite?: number;
  schemaVersion?: TokenUsage["schemaVersion"];
  accounting?: {
    measured?: number;
    estimated?: number;
    legacyUnclassified?: number;
    journalReplay?: number;
    reasoning?: {
      tokens?: number;
      includedInOutput?: true;
    };
    providerCache?: {
      read?: number;
      write?: number;
    };
  };
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  /** Backward-compatible public shape; live results include the richer optional accounting fields. */
  tokenUsage?: WorkflowTokenUsage;
  runtimeCheckpoint?: RuntimeCheckpoint;
  budget?: { limit: number; spent: number; overshoot: number };
  /** Bounded retained-worktree cleanup failures. Successful cleanup omits this field. */
  worktreeCleanupFailures?: WorktreeCleanupFailure[];
}

export interface NestedWorkflowOptions {
  /** Stable sibling identity within the parent accounting scope. Whitespace is trimmed. */
  key?: string;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config (see /workflows-models). An explicit `model` takes
   * precedence; a tier takes precedence over the phase model. When the tier has
   * no configured entry it falls back to the session's main model.
   */
  tier?: string;
  isolation?: "worktree";
  /** Keep a newly isolated worktree alive and return `{ result, worktree }`. */
  retainWorktree?: boolean;
  /** Bind this agent exclusively to a runtime-issued retained-worktree handle. */
  worktree?: WorktreeHandle;
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  currentPhaseKey?: string;
  phaseKeys: Map<string, string>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const MAX_WORKTREE_CLEANUP_DIAGNOSTIC_LENGTH = 1024;

function worktreeCleanupDispatchFailure(worktree: Worktree, error: unknown): WorktreeCleanupFailure {
  return {
    stage: "cleanup_dispatch",
    message: (error instanceof Error ? error.message : String(error)).slice(0, MAX_WORKTREE_CLEANUP_DIAGNOSTIC_LENGTH),
    identity: {
      repoRoot: worktree.repoRoot ?? "",
      worktreePath: worktree.cwd,
      branchRef: worktree.branchRef ?? (worktree.branch ? `refs/heads/${worktree.branch}` : ""),
      baseSha: worktree.baseSha ?? "",
    },
  };
}

async function disposeWorktreeProofsSafely(
  operations: WorktreeOperations,
  worktree: Worktree,
  reportFailure: (failure: WorktreeCleanupFailure) => void,
): Promise<void> {
  try {
    await Promise.resolve().then(() =>
      (operations.disposeWorktreeProofs ?? DEFAULT_WORKTREE_OPERATIONS.disposeWorktreeProofs)?.(worktree),
    );
  } catch (error) {
    reportFailure(worktreeCleanupDispatchFailure(worktree, error));
  }
}

const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${randomUUID()}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const scopeKey = options.scopeKey ?? "root";
  const accountingScopeKey = options.accountingScopeKey ?? options.phaseScopeKey ?? scopeKey;
  const operationScopeKey = options.operationScopeKey ?? `${accountingScopeKey}/invocation:${randomUUID()}`;
  const phaseKeys = new Map<string, string>();
  for (const declaredPhase of meta.phases ?? []) {
    if (!phaseKeys.has(declaredPhase.title)) {
      phaseKeys.set(declaredPhase.title, stablePhaseKey(accountingScopeKey, declaredPhase.title));
    }
  }
  const initialPhase = meta.phases?.[0]?.title;
  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: initialPhase ? [initialPhase] : [],
    currentPhase: initialPhase,
    currentPhaseKey: initialPhase ? phaseKeys.get(initialPhase) : undefined,
    phaseKeys,
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  const invocationDepth = options.nestingDepth ?? 0;
  // Global caps + accounting are shared with nested workflow() calls. Retained
  // capabilities are separately scoped to this root execution context. The call
  // that creates that context owns terminal cleanup; legacy SharedRuntime.depth
  // is compatibility data only and never conveys ownership.
  const shared = resolveSharedRuntime(options, concurrency);
  const ownsExecutionContext = options.executionContext === undefined;
  const executionContext =
    options.executionContext ??
    createRootExecutionContext(options.worktreeOperations, options.onWorktreeCleanupFailure);
  const limiter = shared.limiter;
  const nestedImplicitIdentities = new Set<string>();
  const nestedExplicitKeys = new Set<string>();
  let localAgentCount = 0;

  // One store instance per run; nested workflow() calls inherit the parent's store
  // so all agents across nesting levels share the same key-value space.
  const store: SharedStore = options.sharedStore ?? new SharedStore();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phaseKeyFor = (title: string): string => {
    const existing = state.phaseKeys.get(title);
    if (existing) return existing;
    const key = stablePhaseKey(accountingScopeKey, title);
    state.phaseKeys.set(title, key);
    return key;
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    state.currentPhaseKey = phaseKeyFor(title);
    if (!state.phases.includes(title)) state.phases.push(title);
    // Replaying phase() updates the declared ceiling without resetting its
    // checkpointed charge. UsageController owns the durable phase state.
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      shared.usage.declarePhase(state.currentPhaseKey, title, phaseOptions.budget);
      syncCompatibilityRuntime(shared);
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.usage.usage.total,
    remaining: () =>
      options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.usage.usage.total),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const reportWorktreeCleanupFailure = (failure: WorktreeCleanupFailure): void => {
    const collected = executionContext.reportWorktreeCleanupFailure(failure);
    if (collected.callbackFailure) {
      logger.error(`worktree cleanup diagnostic callback failed: ${collected.callbackFailure.message}`);
    }
    if (!collected.admittedFailure) return;
    try {
      log(`worktree cleanup failed at ${collected.admittedFailure.stage}: ${collected.admittedFailure.message}`);
    } catch {
      // Cleanup observability is best-effort and must never replace the primary outcome.
    }
  };

  const runAgent = async (
    operationAdmission: RootOperationAdmission,
    prompt: string,
    agentOptions: Readonly<AgentOptions>,
  ) => {
    throwIfAborted();

    const assignedPhase = agentOptions.phase ?? state.currentPhase;
    const assignedPhaseKey = assignedPhase
      ? agentOptions.phase
        ? phaseKeyFor(assignedPhase)
        : (state.currentPhaseKey ?? phaseKeyFor(assignedPhase))
      : undefined;

    const requestedLabel = agentOptions.label?.trim();

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }
    const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
    if (agentOptions.worktree !== undefined && resolvedIsolation !== undefined) {
      throw new TypeError("agent({ worktree }) cannot be combined with isolation, including agentType isolation");
    }
    if (agentOptions.retainWorktree && resolvedIsolation !== "worktree") {
      throw new TypeError("retainWorktree requires isolation: 'worktree'");
    }
    const capabilityCall = agentOptions.retainWorktree === true || agentOptions.worktree !== undefined;
    if (capabilityCall) markRetainedWorktreeUse(executionContext, operationScopeKey);

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const callKey = `${scopeKey}/call:${callIndex}`;
    const accountingCallKey = stableAccountingCallKey(accountingScopeKey, callIndex);
    const callHash = hashAgentCall(prompt, modelSpec, assignedPhase, agentOptions, agentDefinitionKey(agentDef));
    const deltaKey = callKey;

    // Retained consumers validate and reserve FIFO admission before they charge
    // maxAgents. Invalid/released/cross-root handles therefore cannot consume a
    // slot. A valid lease is released below if any later admission gate fails.
    const admittedRetainedLease =
      agentOptions.worktree === undefined
        ? undefined
        : executionContext.retainedWorktrees.acquire(agentOptions.worktree, operationAdmission);

    if (shared.agentCount >= maxAgents) {
      if (admittedRetainedLease !== undefined) {
        void admittedRetainedLease.then(
          (lease) => lease.release(),
          () => undefined,
        );
      }
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    // Reserve the agent slot synchronously — atomic with the limit gate above —
    // so a parallel() fan-out cannot overshoot maxAgents. Token budget remains a
    // soft gate because delayed telemetry may arrive after concurrent admission.
    shared.agentCount++;
    localAgentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = capabilityCall
      ? undefined
      : resumeEntry(options.resumeJournal, {
          callKey,
          callIndex,
          scopeKey: options.scopeKey ?? "root",
          accountingScopeKey,
          accountingCallKey,
          kind: "agent",
          callHash,
        });
    const hashMatches = cached != null;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      const replayTokens = cached.tokens ?? cached.usage?.total ?? 0;
      shared.usage.addReplay(replayTokens);
      syncCompatibilityRuntime(shared);
      options.onJournalReplay?.(cached);
      options.onAgentStart?.({
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        key: callKey,
        accountingCallKey,
        replayed: true,
      });
      options.onAgentEnd?.({
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: replayTokens,
        model: displayModel,
        key: callKey,
        accountingCallKey,
        replayed: true,
      });
      // Apply this agent's write delta so live agents later in the run see a
      // consistent store. Original sequence metadata preserves cross-agent
      // last-write-wins ordering even when replay happens in lexical call order.
      if (cached.storeDelta) store.applyDelta(cached.storeDelta, scopeKey, cached.storeDeltaSequences);
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    let limiterStarted = false;
    const invocation = limiter(async () => {
      limiterStarted = true;
      const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
      const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
      const maxAttempts = retryAttempts + 1;

      // Ordinary isolation owns its worktree only for this call. A retained producer
      // registers the runtime-created tree before attempts begin; a consumer takes a
      // FIFO-exclusive lease on an existing registration.
      let worktree: Worktree | undefined;
      let retainedHandle: WorktreeHandle | undefined;
      let retainedLease: RetainedWorktreeLease | undefined;
      try {
        if (admittedRetainedLease !== undefined) {
          retainedLease = await admittedRetainedLease;
          worktree = retainedLease.worktree;
        } else if (resolvedIsolation === "worktree") {
          worktree = await (options.worktreeOperations ?? DEFAULT_WORKTREE_OPERATIONS).createWorktree(
            baseCwd,
            `${runId}-${callIndex}`,
          );
          if (!worktree.isolated) {
            if (worktree.creationRecoveryWorktree) {
              executionContext.terminalRetryWorktrees.add(worktree.creationRecoveryWorktree);
            }
            if (worktree.recoveryFailures && worktree.recoveryFailures.length > 0) {
              const safeFailures = worktree.recoveryFailures.map(boundWorktreeCleanupFailure);
              log("isolation ignored because worktree creation recovery failed");
              for (const failure of safeFailures) reportWorktreeCleanupFailure(failure);
              throw new WorkflowError(
                "Worktree creation recovery failed; inspect bounded cleanup diagnostics",
                WorkflowErrorCode.AGENT_EXECUTION_ERROR,
                { recoverable: false, details: safeFailures },
              );
            }
            log(`isolation ignored for "${label}" (${worktree.reason})`);
            if (agentOptions.retainWorktree) {
              throw new WorkflowError(
                `Cannot retain worktree for "${label}": ${worktree.reason ?? "isolation unavailable"}`,
                WorkflowErrorCode.AGENT_EXECUTION_ERROR,
                { recoverable: false },
              );
            }
          } else if (agentOptions.retainWorktree) {
            retainedHandle = executionContext.retainedWorktrees.register(worktree, operationAdmission);
          }
        }
        const runCwd = worktree?.isolated ? worktree.cwd : undefined;
        options.onAgentStart?.({
          label,
          phase: assignedPhase,
          prompt,
          model: displayModel,
          key: callKey,
          accountingCallKey,
        });
        const publicResult = (result: unknown): unknown =>
          retainedHandle === undefined
            ? result
            : ({ result, worktree: retainedHandle } satisfies RetainedWorktreeResult<unknown>);

        const logicalUsage = shared.usage.priorAttemptUsage(callKey, callHash, accountingCallKey, accountingScopeKey);
        const firstAttemptNumber = shared.usage.nextAttemptNumber(callKey, accountingCallKey, accountingScopeKey);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const admissionFailure = shared.usage.admissionFailure(assignedPhaseKey);
          if (admissionFailure) {
            const workflowError = budgetError(admissionFailure, shared.usage.usage);
            options.onAgentEnd?.({
              label,
              phase: assignedPhase,
              result: null,
              tokens: logicalUsage.total,
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
              key: callKey,
              accountingCallKey,
            });
            throw workflowError;
          }
          throwIfAborted();

          const attemptController = new AbortController();
          const attemptId = shared.usage.startAttempt(
            callKey,
            firstAttemptNumber + attempt - 1,
            callHash,
            assignedPhase,
            attemptController,
            assignedPhaseKey,
            accountingScopeKey,
            operationScopeKey,
            accountingCallKey,
          );
          try {
            const result = await runAttemptWithSettlement(
              () =>
                agentRunner.run(prompt, {
                  label,
                  // Identifiable name for persisted sessions (persistAgentSessions).
                  sessionName: `workflow:${runId} ${label}`,
                  schema: agentOptions.schema,
                  signal: attemptController.signal,
                  instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
                  model: modelSpec,
                  tier: agentOptions.tier,
                  modelRegistry: options.modelRegistry,
                  toolNames: agentDef?.tools,
                  disallowedToolNames: agentDef?.disallowedTools,
                  // Per-agent store tools track this agent's writes by the
                  // run-unique deltaKey so the delta can be journaled and replayed
                  // correctly on resume, even when a nested workflow() run shares
                  // this store concurrently with the parent run.
                  systemTools: createAgentStoreTools(store, deltaKey, scopeKey),
                  cwd: runCwd,
                  onModelResolved: (id: string) => {
                    displayModel = id;
                  },
                  onModelFallback: (spec: string) => {
                    // Make the silent degrade visible in /workflows, not just console.
                    log(`${label}: model "${spec}" unavailable — using the session default`);
                  },
                  onUsage: (usage: AgentUsage) => {
                    // Final telemetry may arrive only after the provider has
                    // completed this attempt. Use it to abort concurrent work,
                    // but let this completed source settle normally.
                    shared.usage.updateAttempt(attemptId, measuredUsage(usage), true, true);
                    syncCompatibilityRuntime(shared);
                  },
                  onUsageUpdate: (usage: AgentUsage) => {
                    shared.usage.updateAttempt(attemptId, measuredUsage(usage), true);
                    syncCompatibilityRuntime(shared);
                  },
                  onHistory: (history: AgentHistoryEntry[]) => {
                    options.onAgentHistory?.({ label, phase: assignedPhase, history, key: callKey, accountingCallKey });
                  },
                }),
              attemptController,
              options.signal,
              timeout,
              label,
            );

            const liveExhaustion = shared.usage.exhaustionFor(attemptId, false);
            if (liveExhaustion) throw budgetError(liveExhaustion, shared.usage.usage);
            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const attemptUsage = shared.usage.settleAttempt(attemptId, "succeeded", {
              estimate: estimatedUsage(prompt, result),
            });
            syncCompatibilityRuntime(shared);
            mergeTokenUsage(logicalUsage, attemptUsage);
            const tokens = logicalUsage.total;
            const storeDelta = store.commitSequencedDelta(deltaKey);
            if (!capabilityCall) {
              options.onAgentJournal?.({
                index: callIndex,
                key: callKey,
                kind: "agent",
                hash: callHash,
                result,
                usage: structuredClone(logicalUsage),
                tokens,
                agentCount: 1,
                accountingScopeKey,
                accountingCallKey,
                storeDelta: storeDelta.values,
                storeDeltaSequences: storeDelta.sequences,
              });
            }
            const returnedResult = publicResult(result);
            options.onAgentEnd?.({
              label,
              phase: assignedPhase,
              result: returnedResult,
              tokens,
              tokenUsage: agentUsageFromTokenUsage(logicalUsage),
              worktree: runCwd,
              model: displayModel,
              key: callKey,
              accountingCallKey,
            });
            return returnedResult;
          } catch (error) {
            const liveExhaustion = shared.usage.exhaustionFor(attemptId);
            const wrapped = wrapError(error, { agentLabel: label });
            const workflowError = options.signal?.aborted
              ? new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })
              : wrapped.code === WorkflowErrorCode.AGENT_TIMEOUT
                ? wrapped
                : liveExhaustion
                  ? budgetError(liveExhaustion, shared.usage.usage)
                  : wrapped;
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const attemptStatus =
              workflowError.code === WorkflowErrorCode.AGENT_TIMEOUT
                ? "timed_out"
                : workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED ||
                    workflowError.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED
                  ? "aborted"
                  : "failed";
            const attemptUsage = shared.usage.settleAttempt(attemptId, attemptStatus, {
              error: workflowError.message,
              estimate: attemptStatus === "aborted" ? undefined : estimatedUsage(prompt, null),
            });
            syncCompatibilityRuntime(shared);
            mergeTokenUsage(logicalUsage, attemptUsage);
            const tokens = logicalUsage.total;

            if (
              workflowError.recoverable &&
              workflowError.code !== WorkflowErrorCode.WORKFLOW_ABORTED &&
              attempt < maxAttempts
            ) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            options.onAgentEnd?.({
              label,
              phase: assignedPhase,
              result: null,
              tokens,
              tokenUsage: agentUsageFromTokenUsage(logicalUsage),
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
              key: callKey,
              accountingCallKey,
            });

            if (workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED) throw workflowError;
            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return publicResult(null);
            }
            throw workflowError;
          }
        }
        return publicResult(null);
      } finally {
        retainedLease?.release();
        // Retained producers are root-owned after registration. Ordinary isolated
        // calls preserve the historical immediate teardown behavior.
        if (worktree?.isolated && retainedHandle === undefined && agentOptions.worktree === undefined) {
          try {
            const failures =
              (await (options.worktreeOperations ?? DEFAULT_WORKTREE_OPERATIONS).removeWorktree(worktree)) ?? [];
            for (const failure of failures) reportWorktreeCleanupFailure(failure);
            if (failures.length > 0) executionContext.terminalProofWorktrees.add(worktree);
          } catch (error) {
            reportWorktreeCleanupFailure(worktreeCleanupDispatchFailure(worktree, error));
            executionContext.terminalProofWorktrees.add(worktree);
          }
        }
      }
    }).catch(async (error: unknown) => {
      if (!limiterStarted && admittedRetainedLease !== undefined) {
        const lease = await admittedRetainedLease;
        lease.release();
      }
      throw error;
    });
    return invocation;
  };

  const agent = (prompt: string, callerOptions: unknown = {}): Promise<unknown> => {
    let admission: RootOperationAdmission;
    let agentOptions: Readonly<AgentOptions>;
    try {
      // Workflow code retains ownership of its options object. Snapshot every
      // recognized field by explicit read before admission or any other runtime
      // side effect. This preserves inherited/non-enumerable fields while never
      // consulting the caller-owned object again after validation.
      agentOptions = snapshotAgentOptions(callerOptions);
      admission = executionContext.admitOperation(options.operationAdmission);
    } catch (error) {
      return safelyRejectedOperation(error);
    }
    return trackRuntimeOperation(
      shared,
      executionContext,
      operationScopeKey,
      runAgent(admission, prompt, agentOptions),
      admission,
    );
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          const workflowError = wrapError(error);
          // Non-recoverable failures (token budget / agent limit exhausted) must
          // halt the whole run, exactly like a directly-awaited agent() — not be
          // swallowed into a null in the result array.
          if (!workflowError.recoverable) throw workflowError;
          log(`parallel[${index}] failed: ${workflowError.message}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures halt the whole run (see parallel()).
            if (!workflowError.recoverable) throw workflowError;
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  // Nested workflow(): the wrapper journal remains positional, while accounting
  // identity is stable. Explicit sibling keys are reorder-safe; an implicit
  // name/script+args identity is permitted only once in a parent invocation.
  const workflowFn = (
    ...workflowArgs: [nameOrScript: string, childArgs?: unknown, childOptions?: NestedWorkflowOptions]
  ) => {
    const [nameOrScript, callerChildArgs, callerChildOptions] = workflowArgs;
    const childArgsProvided = workflowArgs.length >= 2;
    let workflowNameInput: string;
    let childArgs: unknown;
    let childOptions: Readonly<NestedWorkflowOptions> | undefined;
    let explicitKey: string | undefined;
    let carriesRetainedWorktree = false;
    let admission: RootOperationAdmission;
    try {
      // Validate and clone every caller-owned value before admission. This keeps
      // synchronous snapshot semantics while ensuring every validation, clone,
      // proxy, accessor, cycle, and capability failure is returned as a rejected
      // Promise from workflow(), rather than escaping before .catch can attach.
      workflowNameInput = String(nameOrScript);
      validateNestedWorkflowOptions(callerChildOptions);
      childOptions = callerChildOptions === undefined ? undefined : Object.freeze({ ...callerChildOptions });
      explicitKey = normalizeNestedWorkflowKey(childOptions);
      if (childArgsProvided) {
        const snapshot = snapshotNestedWorkflowArgs(callerChildArgs, executionContext.retainedWorktrees);
        childArgs = snapshot.value;
        carriesRetainedWorktree = snapshot.carriesRetainedWorktree;
      }
      admission = executionContext.admitOperation(options.operationAdmission);
    } catch (error) {
      return safelyRejectedOperation(error);
    }
    return trackRuntimeOperation(
      shared,
      executionContext,
      operationScopeKey,
      (async () => {
        throwIfAborted();
        if (invocationDepth >= 1) {
          throw new WorkflowError(
            "workflow() can nest only one level deep",
            WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
            {
              recoverable: false,
            },
          );
        }
        const workflowName = workflowNameInput;
        const resolved = options.loadSavedWorkflow?.(workflowName);
        const childScript = resolved ?? workflowName;
        const implicitIdentity = hashNestedWorkflowIdentity(
          resolved === undefined ? undefined : workflowName,
          childScript,
          childArgsProvided,
          childArgs,
          executionContext.retainedWorktrees,
        );
        let childAccountingScope: string;
        if (explicitKey !== undefined) {
          if (nestedExplicitKeys.has(explicitKey)) {
            throw new WorkflowError(
              `duplicate workflow() key "${explicitKey}" in one parent; explicit keys must be unique`,
              WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
              { recoverable: false },
            );
          }
          nestedExplicitKeys.add(explicitKey);
          childAccountingScope = `${accountingScopeKey}/workflow-key:${sha256(explicitKey)}`;
        } else {
          if (nestedImplicitIdentities.has(implicitIdentity)) {
            throw new WorkflowError(
              "duplicate implicit workflow() identity in one parent; provide a unique third-argument { key } for identical siblings",
              WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
              { recoverable: false },
            );
          }
          nestedImplicitIdentities.add(implicitIdentity);
          // Preserve the only unambiguous legacy scope: implicit occurrence 0.
          childAccountingScope = `${accountingScopeKey}/workflow:${implicitIdentity}/occurrence:0`;
        }
        const childOperationScope = `${childAccountingScope}/invocation:${randomUUID()}`;
        if (carriesRetainedWorktree) markRetainedWorktreeUse(executionContext, childOperationScope);
        const callIndex = state.callSeq++;
        const callKey = `${scopeKey}/call:${callIndex}`;
        const childJournalScope = `${callKey}/workflow`;
        const wrapperAccountingCallKey = stableAccountingCallKey(accountingScopeKey, callIndex);
        const callHash = hashNestedWorkflow(
          childScript,
          childArgsProvided,
          childArgs,
          executionContext.retainedWorktrees,
          explicitKey,
        );
        // Wrapper checkpoints intentionally remain positional. A keyed wrapper miss
        // can still reuse stable descendant journals from its accounting scope.
        const cached = carriesRetainedWorktree
          ? undefined
          : resumeEntry(options.resumeJournal, {
              callKey,
              callIndex,
              scopeKey: options.scopeKey ?? "root",
              accountingScopeKey: childAccountingScope,
              kind: "workflow",
              callHash,
            });
        if (cached && callIndex < state.firstMiss) {
          const replayedAgents = cached.agentCount ?? 0;
          if (shared.agentCount + replayedAgents > maxAgents) {
            throw new WorkflowError(`Agent limit exceeded (${maxAgents}).`, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED, {
              recoverable: false,
            });
          }
          shared.agentCount += replayedAgents;
          localAgentCount += replayedAgents;
          const rebasedStoreDelta = cached.storeDelta
            ? store.applyRebasedDelta(cached.storeDelta, cached.storeDeltaSequences)
            : undefined;
          shared.usage.addReplay(cached.tokens ?? cached.usage?.total ?? 0);
          syncCompatibilityRuntime(shared);
          const reordered = cached.key !== callKey;
          const replayedEntry = reordered
            ? {
                ...cached,
                index: callIndex,
                key: callKey,
                accountingCallKey: wrapperAccountingCallKey,
                storeDelta: rebasedStoreDelta?.values ?? cached.storeDelta,
                storeDeltaSequences: rebasedStoreDelta?.sequences ?? cached.storeDeltaSequences,
              }
            : cached;
          options.onJournalReplay?.(replayedEntry);
          // Rebase a reordered stable wrapper to its current physical key so the
          // persisted newest generation supersedes the stale position. Same-key
          // replay remains callback-compatible and does not rewrite the journal.
          if (reordered) options.onAgentJournal?.(replayedEntry);
          return cached.result;
        }
        state.firstMiss = Math.min(state.firstMiss, callIndex);

        const legacyJournal = hasAmbiguousLegacyJournal(options.resumeJournal);
        const keyedJournalMatches =
          explicitKey === undefined ||
          cached?.accountingScopeKey === childAccountingScope ||
          journalHasAccountingScope(options.resumeJournal, childAccountingScope);
        if (legacyJournal || !keyedJournalMatches) {
          log(
            legacyJournal
              ? "legacy nested journal has ambiguous numeric identities; rerunning nested workflow safely"
              : `nested workflow key "${explicitKey}" has no matching stable journal identity; starting it fresh`,
          );
        }
        const descendantAgentAccountingCallKeys = new Set<string>();
        const observeDescendantAgent = (entry: JournalEntry): void => {
          if (entry.kind === "agent" && entry.accountingCallKey) {
            descendantAgentAccountingCallKeys.add(entry.accountingCallKey);
          }
        };
        const child = await runWorkflow(childScript, {
          ...options,
          args: childArgs,
          sharedRuntime: shared,
          executionContext,
          operationAdmission: admission,
          sharedStore: store,
          scopeKey: childJournalScope,
          accountingScopeKey: childAccountingScope,
          phaseScopeKey: childAccountingScope,
          operationScopeKey: childOperationScope,
          nestingDepth: invocationDepth + 1,
          resumeJournal: legacyJournal || !keyedJournalMatches ? undefined : options.resumeJournal,
          resumeFromRunId: options.resumeFromRunId,
          runId: `${runId}-${callKey.replaceAll("/", "-")}`,
          persistLogs: false,
          onAgentStart: (event) => {
            if (event.accountingCallKey) descendantAgentAccountingCallKeys.add(event.accountingCallKey);
            options.onAgentStart?.(event);
          },
          onAgentJournal: (entry) => {
            observeDescendantAgent(entry);
            options.onAgentJournal?.(entry);
          },
          onJournalReplay: (entry) => {
            observeDescendantAgent(entry);
            options.onJournalReplay?.(entry);
          },
        });
        const storeDelta = store.commitSequencedScopeDeltas(childJournalScope);
        const childUsage = shared.usage.usageForScope(childAccountingScope);
        if (!consumeRetainedWorktreeUse(executionContext, childOperationScope)) {
          options.onAgentJournal?.({
            index: callIndex,
            key: callKey,
            kind: "workflow",
            hash: callHash,
            result: child.result,
            usage: childUsage,
            tokens: childUsage.total,
            agentCount: child.agentCount,
            descendantAgentAccountingCallKeys: [...descendantAgentAccountingCallKeys],
            accountingScopeKey: childAccountingScope,
            accountingCallKey: wrapperAccountingCallKey,
            storeDelta: storeDelta.values,
            storeDeltaSequences: storeDelta.sequences,
          });
        }
        return child.result;
      })(),
      admission,
    );
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    let admission: RootOperationAdmission;
    try {
      admission = executionContext.admitOperation(options.operationAdmission);
    } catch (error) {
      return safelyRejectedOperation(error);
    }
    return trackRuntimeOperation(
      shared,
      executionContext,
      operationScopeKey,
      (async () => {
        throwIfAborted();
        if (typeof promptText !== "string")
          throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
        if (shared.agentCount >= maxAgents) {
          throw new WorkflowError(
            `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
            WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
            { recoverable: false },
          );
        }
        const callIndex = state.callSeq++;
        const callKey = `${scopeKey}/call:${callIndex}`;
        const accountingCallKey = stableAccountingCallKey(accountingScopeKey, callIndex);
        const callHash = hashCheckpoint(promptText, checkpointOptions);
        const cached = resumeEntry(options.resumeJournal, {
          callKey,
          callIndex,
          scopeKey: options.scopeKey ?? "root",
          accountingScopeKey,
          accountingCallKey,
          kind: "checkpoint",
          callHash,
        });
        if (cached != null && callIndex < state.firstMiss) {
          shared.agentCount++;
          localAgentCount++;
          options.onJournalReplay?.(cached);
          return cached.result; // replay the journaled human reply
        }
        if (cached == null) state.firstMiss = Math.min(state.firstMiss, callIndex);
        shared.agentCount++;
        localAgentCount++;

        let reply: unknown;
        if (options.confirm) {
          reply = await options.confirm(promptText, checkpointOptions);
        } else if (checkpointOptions.headless === "abort") {
          throw new WorkflowError(
            `checkpoint "${promptText}" needs human input but none is available (headless run)`,
            WorkflowErrorCode.WORKFLOW_ABORTED,
            { recoverable: false },
          );
        } else {
          reply = checkpointOptions.default ?? true;
        }
        throwIfAborted();
        options.onAgentJournal?.({
          index: callIndex,
          key: callKey,
          kind: "checkpoint",
          hash: callHash,
          result: reply,
          accountingScopeKey,
          accountingCallKey,
        });
        return reply;
      })(),
      admission,
    );
  };

  const releaseWorktree = (handle: unknown): Promise<void> => {
    let admission: RootOperationAdmission;
    try {
      admission = executionContext.admitOperation(options.operationAdmission);
    } catch (error) {
      return safelyRejectedOperation(error);
    }
    let release: Promise<void>;
    try {
      release = executionContext.retainedWorktrees.release(handle, admission);
    } catch (error) {
      executionContext.completeOperationAdmission(admission);
      return safelyRejectedOperation(error);
    }
    return trackRuntimeOperation(shared, executionContext, operationScopeKey, release, admission);
  };

  const context = vm.createContext({
    agent,
    releaseWorktree,
    parallel,
    pipeline,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  let completedResult: WorkflowRunResult<T> | undefined;
  try {
    let result: unknown;
    let scriptFailure: unknown;
    let scriptFailed = false;
    try {
      result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
    } catch (error) {
      scriptFailed = true;
      scriptFailure = error;
    }
    if (ownsExecutionContext) executionContext.closeOperationAdmission();

    // Native Promise.all is fail-fast and can discard sibling operations. Every
    // nested invocation drains only its own descendants. A top-level invocation
    // drains its explicit root group, while the shared global registry remains
    // available only for manager stop/abort lease and deletion safety.
    const liveFailures =
      invocationDepth === 0
        ? await settleRootOperations(executionContext)
        : await settleOwnedOperations(shared, operationScopeKey);
    // Resolve terminal state only after owned operations drain. Parent abort is
    // always terminal. Otherwise an uncaught script/runner error remains the
    // primary failure. Budget exhaustion is the final-only gate when the script
    // otherwise succeeds or catches/recoverably consumes an agent failure.
    if (options.signal?.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
    const terminalExhaustion = shared.usage.terminalExhaustion(accountingScopeKey);
    if (scriptFailed) {
      const failure = wrapError(scriptFailure);
      if (failure.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED && terminalExhaustion) {
        throw budgetError(terminalExhaustion, shared.usage.usage);
      }
      throw scriptFailure;
    }
    if (liveFailures.length > 0) {
      const failure = wrapError(liveFailures[0]);
      if (failure.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED && terminalExhaustion) {
        throw budgetError(terminalExhaustion, shared.usage.usage);
      }
      throw liveFailures[0];
    }
    if (terminalExhaustion) throw budgetError(terminalExhaustion, shared.usage.usage);

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    syncCompatibilityRuntime(shared);
    const runtimeCheckpoint = shared.usage.checkpoint();
    options.onRuntimeCheckpoint?.(runtimeCheckpoint);
    options.onTokenUsage?.(runtimeCheckpoint.usage);
    const budgetStatus =
      options.tokenBudget == null
        ? undefined
        : {
            limit: options.tokenBudget,
            spent: runtimeCheckpoint.usage.total,
            overshoot: Math.max(0, runtimeCheckpoint.usage.total - options.tokenBudget),
          };

    completedResult = {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: invocationDepth > 0 ? localAgentCount : shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: runtimeCheckpoint.usage,
      runtimeCheckpoint,
      budget: budgetStatus,
    };
    return completedResult;
  } finally {
    // Only the root owns terminal cleanup. Nested workflow settlement must leave
    // shared handles available to later parent steps. cleanupAll closes admission,
    // waits any active/admitted consumers, and never masks the primary outcome.
    if (ownsExecutionContext) {
      executionContext.retainedWorktrees.closeAdmission();
      await executionContext.retainedWorktrees.cleanupAll();
      const operations = options.worktreeOperations ?? DEFAULT_WORKTREE_OPERATIONS;
      await Promise.allSettled(
        [...executionContext.terminalRetryWorktrees].map(async (worktree) => {
          let terminalFailures: WorktreeCleanupFailure[];
          try {
            terminalFailures = (await operations.removeWorktree(worktree)) ?? [];
          } catch (error) {
            terminalFailures = [worktreeCleanupDispatchFailure(worktree, error)];
          }
          for (const failure of terminalFailures) reportWorktreeCleanupFailure(failure);
          if (terminalFailures.length > 0) {
            await disposeWorktreeProofsSafely(operations, worktree, reportWorktreeCleanupFailure);
          }
        }),
      );
      executionContext.terminalRetryWorktrees.clear();
      await Promise.allSettled(
        [...executionContext.terminalProofWorktrees].map((worktree) =>
          disposeWorktreeProofsSafely(operations, worktree, reportWorktreeCleanupFailure),
        ),
      );
      executionContext.terminalProofWorktrees.clear();
      if (executionContext.worktreeCleanupFailures.length > 0) {
        for (const failure of executionContext.worktreeCleanupFailures) {
          // Deliberately omit messages and identities: both can carry absolute
          // paths. Exact bounded recovery data is available on result/status.
          try {
            log(`retained worktree cleanup failed at ${failure.stage}; inspect worktreeCleanupFailures metadata`);
          } catch {
            // Cleanup observability must never replace the primary outcome.
          }
        }
        if (completedResult) {
          completedResult.worktreeCleanupFailures = executionContext.worktreeCleanupFailures.map((failure) =>
            boundWorktreeCleanupFailure(failure),
          );
        }
      }
    }
    // Dispose the store only when this run created it, and only after the root
    // ownership drain above has observed every live invocation settle.
    if (!options.sharedStore) store.dispose();
  }
}

function resolveSharedRuntime(options: WorkflowRunOptions, concurrency: number): ActiveSharedRuntime {
  const provided = options.sharedRuntime;
  let shared: ActiveSharedRuntime;
  const initialUsage = options.initialTokenUsage;
  const restoredInitialUsage =
    initialUsage && (initialUsage as Partial<TokenUsage>).schemaVersion === 1
      ? restoreTokenUsage(initialUsage as TokenUsage)
      : restoreTokenUsage({
          input: initialUsage?.input ?? 0,
          output: initialUsage?.output ?? 0,
          total: Math.max(initialUsage?.total ?? 0, options.initialTokenSpend ?? 0),
          cost: initialUsage?.cost ?? 0,
          cacheRead: initialUsage?.cacheRead ?? 0,
          cacheWrite: initialUsage?.cacheWrite ?? 0,
        });
  const initialCheckpoint =
    options.runtimeCheckpoint ??
    (provided
      ? {
          schemaVersion: 1 as const,
          usage: restoreTokenUsage(provided.tokenUsage),
          phaseBudgets: {},
          attempts: {},
        }
      : initialUsage || options.initialTokenSpend !== undefined
        ? {
            schemaVersion: 1 as const,
            usage: restoredInitialUsage,
            phaseBudgets: {},
            attempts: {},
          }
        : undefined);
  const usage =
    provided?.usage ??
    new UsageController({
      tokenBudget: options.tokenBudget,
      checkpoint: initialCheckpoint,
      onChange: (checkpoint) => {
        if (shared) syncCompatibilityRuntime(shared);
        options.onRuntimeCheckpoint?.(checkpoint);
      },
    });

  if (provided) {
    provided.usage = usage;
    provided.liveInvocations ??= new Set<Promise<unknown>>();
    provided.liveOperationsByScope ??= new Map<string, Set<Promise<unknown>>>();
    provided.tokenUsage = usage.usage;
    shared = provided as ActiveSharedRuntime;
  } else {
    shared = {
      limiter: createLimiter(concurrency),
      agentCount: 0,
      spent: usage.usage.total,
      tokenUsage: usage.usage,
      depth: options.nestingDepth ?? 0,
      usage,
      liveInvocations: new Set<Promise<unknown>>(),
      liveOperationsByScope: new Map<string, Set<Promise<unknown>>>(),
    };
  }
  syncCompatibilityRuntime(shared);
  return shared;
}

function syncCompatibilityRuntime(shared: ActiveSharedRuntime): void {
  shared.spent = shared.usage.usage.total;
  shared.tokenUsage = shared.usage.usage;
}

function detachedWorktreeCleanupFailure(failure: WorktreeCleanupFailure): WorktreeCleanupFailure {
  return {
    stage: failure.stage,
    message: failure.message,
    identity: { ...failure.identity },
  };
}

function immutableWorktreeCleanupFailure(failure: WorktreeCleanupFailure): WorktreeCleanupFailure {
  const identity = Object.freeze({ ...failure.identity });
  return Object.freeze({
    stage: failure.stage,
    message: failure.message,
    identity,
  });
}

function createRootExecutionContext(
  operations: WorktreeOperations | undefined,
  onCleanupFailure: ((failure: WorktreeCleanupFailure) => void | PromiseLike<void>) | undefined,
): RootExecutionContext {
  const worktreeCleanupFailures: WorktreeCleanupFailure[] = [];
  const worktreeCleanupFailureKeys = new Set<string>();
  const admissionOwner = Symbol("root-operation-admission");
  const activeAdmissions = new WeakSet<RootOperationAdmission>();
  let operationAdmissionOpen = true;
  const validAdmission = (candidate: unknown): candidate is RootOperationAdmission =>
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as RootOperationAdmission).owner === admissionOwner &&
    activeAdmissions.has(candidate as RootOperationAdmission);
  const admitOperation = (parent?: RootOperationAdmission): RootOperationAdmission => {
    if (parent !== undefined ? !validAdmission(parent) : !operationAdmissionOpen) {
      throw new WorkflowError(
        "Root execution admission is closed after script settlement",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const admission = Object.freeze({ owner: admissionOwner });
    activeAdmissions.add(admission);
    return admission;
  };
  const reportCleanupFailure = (failure: WorktreeCleanupFailure): CleanupFailureCollectionResult => {
    const bounded = boundWorktreeCleanupFailure(failure);
    const key = JSON.stringify(bounded);
    if (worktreeCleanupFailureKeys.has(key) || worktreeCleanupFailures.length >= MAX_WORKTREE_CLEANUP_FAILURES) {
      return {};
    }
    worktreeCleanupFailureKeys.add(key);
    const stored = immutableWorktreeCleanupFailure(detachedWorktreeCleanupFailure(bounded));
    worktreeCleanupFailures.push(stored);
    const admittedFailure = immutableWorktreeCleanupFailure(detachedWorktreeCleanupFailure(stored));
    try {
      const callbackResult = onCleanupFailure?.(detachedWorktreeCleanupFailure(stored));
      if (callbackResult !== undefined) {
        // User diagnostics are never on the workflow critical path, but every
        // Promise/thenable rejection must still be consumed.
        void Promise.resolve(callbackResult).catch(() => undefined);
      }
      return { admittedFailure };
    } catch (error) {
      return {
        admittedFailure,
        callbackFailure: boundWorktreeCleanupFailure({
          stage: "cleanup_dispatch",
          message: error instanceof Error ? error.message : String(error),
          identity: detachedWorktreeCleanupFailure(stored).identity,
        }),
      };
    }
  };
  return {
    retainedWorktrees: new RetainedWorktreeRegistry(
      operations ?? DEFAULT_WORKTREE_OPERATIONS,
      reportCleanupFailure,
      validAdmission,
    ),
    admitOperation,
    completeOperationAdmission: (admission) => activeAdmissions.delete(admission),
    closeOperationAdmission: () => {
      operationAdmissionOpen = false;
    },
    retainedWorktreeUseScopes: new Set<string>(),
    worktreeCleanupFailures,
    reportWorktreeCleanupFailure: reportCleanupFailure,
    terminalProofWorktrees: new Set<Worktree>(),
    terminalRetryWorktrees: new Set<Worktree>(),
    liveOperations: new Set<Promise<unknown>>(),
  };
}

function markRetainedWorktreeUse(context: RootExecutionContext, operationScopeKey: string): void {
  context.retainedWorktreeUseScopes.add(operationScopeKey);
}

function consumeRetainedWorktreeUse(context: RootExecutionContext, operationScopeKey: string): boolean {
  return context.retainedWorktreeUseScopes.delete(operationScopeKey);
}

function safelyRejectedOperation(error: unknown): Promise<never> {
  const rejection = Promise.reject(error);
  void rejection.catch(() => undefined);
  return rejection;
}

function trackRuntimeOperation<T>(
  shared: ActiveSharedRuntime,
  executionContext: RootExecutionContext,
  ownerScopeKey: string,
  operation: Promise<T>,
  admission?: RootOperationAdmission,
): Promise<T> {
  shared.liveInvocations.add(operation);
  executionContext.liveOperations.add(operation);
  let owned = shared.liveOperationsByScope.get(ownerScopeKey);
  if (!owned) {
    owned = new Set<Promise<unknown>>();
    shared.liveOperationsByScope.set(ownerScopeKey, owned);
  }
  owned.add(operation);
  const release = () => {
    if (admission) executionContext.completeOperationAdmission(admission);
    shared.liveInvocations.delete(operation);
    executionContext.liveOperations.delete(operation);
    owned?.delete(operation);
    if (owned?.size === 0 && shared.liveOperationsByScope.get(ownerScopeKey) === owned) {
      shared.liveOperationsByScope.delete(ownerScopeKey);
    }
  };
  void operation.then(release, release);
  return operation;
}

async function settleOwnedOperations(shared: ActiveSharedRuntime, ownerScopeKey: string): Promise<unknown[]> {
  const failures: unknown[] = [];
  do {
    const owned = shared.liveOperationsByScope.get(ownerScopeKey);
    const settled = await Promise.allSettled([...(owned ?? [])]);
    for (const result of settled) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while ((shared.liveOperationsByScope.get(ownerScopeKey)?.size ?? 0) > 0);
  const owned = shared.liveOperationsByScope.get(ownerScopeKey);
  if (!owned || owned.size === 0) shared.liveOperationsByScope.delete(ownerScopeKey);
  return failures;
}

async function settleRootOperations(executionContext: RootExecutionContext): Promise<unknown[]> {
  const failures: unknown[] = [];
  do {
    const settled = await Promise.allSettled([...executionContext.liveOperations]);
    for (const result of settled) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    // A settled checkpoint/workflow can resume a native-Promise branch whose
    // continuation registers another operation in this root. Observe one full
    // event-loop turn before declaring this root's registry stably empty.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (executionContext.liveOperations.size > 0);
  return failures;
}

function stablePhaseKey(scopeKey: string, title: string): string {
  return `${scopeKey}/phase:${encodeURIComponent(title)}`;
}

function stableAccountingCallKey(accountingScopeKey: string, callIndex: number): string {
  return `${accountingScopeKey}/call:${callIndex}`;
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function invalidAgentOptions(message: string): WorkflowError {
  return new WorkflowError(`Invalid agent options: ${message}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
  });
}

function snapshotAgentOptions(value: unknown): Readonly<AgentOptions> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidAgentOptions("agent() second argument must be an options object");
  }

  const source = value as AgentOptions;
  const read = <K extends keyof AgentOptions>(key: K): AgentOptions[K] => {
    try {
      return source[key];
    } catch {
      throw invalidAgentOptions(`${key} property accessor could not be read`);
    }
  };
  const options: AgentOptions = {
    label: read("label"),
    phase: read("phase"),
    schema: read("schema"),
    model: read("model"),
    tier: read("tier"),
    isolation: read("isolation"),
    retainWorktree: read("retainWorktree"),
    worktree: read("worktree"),
    agentType: read("agentType"),
    timeoutMs: read("timeoutMs"),
    retries: read("retries"),
  };

  for (const key of ["label", "phase", "model", "tier", "agentType"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "string") {
      throw invalidAgentOptions(`${key} must be a string`);
    }
  }
  if (
    options.schema !== undefined &&
    (options.schema === null || typeof options.schema !== "object" || Array.isArray(options.schema))
  ) {
    throw invalidAgentOptions("schema must be an object");
  }
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    throw invalidAgentOptions("isolation must be 'worktree'");
  }
  if (options.retainWorktree !== undefined && typeof options.retainWorktree !== "boolean") {
    throw invalidAgentOptions("retainWorktree must be a boolean");
  }
  if (
    options.worktree !== undefined &&
    (options.worktree === null || typeof options.worktree !== "object" || Array.isArray(options.worktree))
  ) {
    throw invalidAgentOptions("worktree must be a runtime-issued handle object");
  }
  if (
    options.timeoutMs !== undefined &&
    options.timeoutMs !== null &&
    (typeof options.timeoutMs !== "number" || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    throw invalidAgentOptions("timeoutMs must be a non-negative finite number or null");
  }
  if (
    options.retries !== undefined &&
    (typeof options.retries !== "number" || !Number.isFinite(options.retries) || options.retries < 0)
  ) {
    throw invalidAgentOptions("retries must be a non-negative finite number");
  }
  if (options.worktree !== undefined && (options.isolation !== undefined || options.retainWorktree === true)) {
    throw invalidAgentOptions("worktree cannot be combined with isolation or retainWorktree: true");
  }
  return Object.freeze(options);
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
): string {
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function estimatedUsage(prompt: string, result: unknown): UsageSample {
  return {
    input: 0,
    output: 0,
    total: estimateTokens(prompt) + estimateTokens(result),
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
    provenance: "estimated",
  };
}

function agentUsageFromTokenUsage(usage: TokenUsage): AgentUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cost: usage.cost,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.accounting.reasoning.tokens,
  };
}

function measuredUsage(usage: AgentUsage): UsageSample {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cost: usage.cost,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    provenance: "measured",
  };
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/** Abort on timeout/parent cancellation, then await the runner's actual settlement. */
async function runAttemptWithSettlement<T>(
  run: () => Promise<T>,
  controller: AbortController,
  parentSignal: AbortSignal | undefined,
  ms: number | null,
  label: string,
): Promise<T> {
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | undefined;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (ms !== null) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Agent ${label} timed out`));
    }, ms);
  }

  let result: T | undefined;
  let failure: unknown;
  try {
    result = await run();
  } catch (error) {
    failure = error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }

  if (parentSignal?.aborted) {
    throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
  }
  if (timedOut) {
    throw new WorkflowError(
      `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: true, agentLabel: label },
    );
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

interface ResumeEntryIdentity {
  callKey: string;
  callIndex: number;
  scopeKey: string;
  accountingScopeKey?: string;
  accountingCallKey?: string;
  kind: NonNullable<JournalEntry["kind"]>;
  callHash: string;
}

function resumeEntry(
  journal: Map<string | number, JournalEntry> | undefined,
  expected: ResumeEntryIdentity,
): JournalEntry | undefined {
  if (!journal) return undefined;
  const entries = [...journal.values()];
  const kindMatches = (entry: JournalEntry): boolean => entry.kind === expected.kind;
  const hashMatches = (entry: JournalEntry): boolean => entry.hash === expected.callHash;

  // Stable identities are authoritative and historical journals may contain
  // several physical generations after keyed sibling reorders. Search newest
  // first, and require the logical kind + call revision to match as well.
  const stable = [...entries].reverse().find((entry) => {
    if (!kindMatches(entry) || !hashMatches(entry)) return false;
    if (expected.kind === "workflow" && expected.accountingScopeKey) {
      return entry.accountingScopeKey === expected.accountingScopeKey;
    }
    return expected.accountingCallKey !== undefined && entry.accountingCallKey === expected.accountingCallKey;
  });
  if (stable) return stable;

  const positional = [...entries]
    .reverse()
    .find(
      (entry) =>
        (entry.key === expected.callKey ||
          (expected.scopeKey === "root" && entry.key === undefined && entry.index === expected.callIndex)) &&
        hashMatches(entry) &&
        (entry.kind === undefined || kindMatches(entry)),
    );
  if (!positional) return undefined;

  // Once the caller has a stable accounting identity, a positional entry from
  // another keyed sibling is never a compatibility fallback. Metadata-free
  // legacy entries remain replayable.
  if (
    expected.accountingScopeKey !== undefined &&
    positional.accountingScopeKey !== undefined &&
    positional.accountingScopeKey !== expected.accountingScopeKey
  ) {
    return undefined;
  }
  if (
    expected.accountingCallKey !== undefined &&
    positional.accountingCallKey !== undefined &&
    positional.accountingCallKey !== expected.accountingCallKey
  ) {
    return undefined;
  }
  return positional;
}

function journalHasAccountingScope(
  journal: Map<string | number, JournalEntry> | undefined,
  accountingScopeKey: string,
): boolean {
  return journal ? [...journal.values()].some((entry) => entry.accountingScopeKey === accountingScopeKey) : false;
}

function hasAmbiguousLegacyJournal(journal: Map<string | number, JournalEntry> | undefined): boolean {
  if (!journal) return false;
  return [...journal.entries()].some(([key, entry]) => typeof key === "number" || !entry.key);
}

function hashNestedWorkflow(
  script: string,
  argsProvided: boolean,
  args: unknown,
  retainedWorktrees: RetainedWorktreeRegistry,
  explicitKey?: string,
): string {
  return sha256(
    canonicalEncode(
      explicitKey === undefined
        ? { script, args: nestedArgsIdentity(argsProvided, args) }
        : { script, args: nestedArgsIdentity(argsProvided, args), key: explicitKey },
      "workflow identity",
      retainedWorktrees,
    ),
  );
}

function validateNestedWorkflowOptions(options: unknown): asserts options is NestedWorkflowOptions | undefined {
  if (options === undefined) return;
  let isPlainObject = false;
  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    try {
      const prototype = Object.getPrototypeOf(options);
      isPlainObject = prototype === null || Object.getPrototypeOf(prototype) === null;
    } catch {
      isPlainObject = false;
    }
  }
  if (!isPlainObject) {
    throw new WorkflowError(
      "workflow() third argument must be an options object",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
}

function normalizeNestedWorkflowKey(options: Readonly<NestedWorkflowOptions> | undefined): string | undefined {
  validateNestedWorkflowOptions(options);
  if (options === undefined || options.key === undefined) return undefined;
  if (typeof options.key !== "string" || options.key.trim().length === 0) {
    throw new WorkflowError(
      "workflow() third-argument key must be a non-empty string",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  return options.key.trim();
}

function hashNestedWorkflowIdentity(
  savedName: string | undefined,
  script: string,
  argsProvided: boolean,
  args: unknown,
  retainedWorktrees: RetainedWorktreeRegistry,
): string {
  const workflowIdentity = savedName === undefined ? { rawScript: sha256(script) } : { savedWorkflow: savedName };
  return sha256(
    canonicalEncode(
      { workflowIdentity, args: nestedArgsIdentity(argsProvided, args) },
      "workflow identity",
      retainedWorktrees,
    ),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nestedArgsIdentity(provided: boolean, value: unknown): unknown {
  return provided ? ["provided", value] : ["omitted"];
}

/** Collision-resistant typed canonical encoding for nested workflow identity. */
function canonicalEncode(
  value: unknown,
  rootPath: string,
  retainedWorktrees?: RetainedWorktreeRegistry,
  onRetainedHandle?: () => void,
): string {
  const ancestors = new WeakSet<object>();
  const encode = (item: unknown, path: string): unknown => {
    if (item === null) return ["null"];
    if (item === undefined) return ["undefined"];
    if (typeof item === "string") return ["string", item];
    if (typeof item === "boolean") return ["boolean", item];
    if (typeof item === "number") {
      if (Number.isNaN(item)) return ["number", "nan"];
      if (item === Number.POSITIVE_INFINITY) return ["number", "+infinity"];
      if (item === Number.NEGATIVE_INFINITY) return ["number", "-infinity"];
      if (Object.is(item, -0)) return ["number", "-0"];
      return ["number", item];
    }
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
      throw invalidNestedIdentity(`${path} contains unsupported ${typeof item}; pass data-only JSON-like values`);
    }
    if (typeof item !== "object") {
      throw invalidNestedIdentity(`${path} contains unsupported value type ${typeof item}`);
    }
    const retainedIdentity = retainedWorktrees?.canonicalIdentity(item);
    if (retainedIdentity !== undefined) {
      onRetainedHandle?.();
      return ["retained-worktree", retainedIdentity];
    }
    if (ancestors.has(item)) {
      throw invalidNestedIdentity(`${path} is cyclic; nested workflow args must be acyclic`);
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        assertNativeDataPrototype(item, "Array", path);
        const descriptors = Object.getOwnPropertyDescriptors(item);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key === "symbol") {
            throw invalidNestedIdentity(`${path} array contains unsupported symbol properties`);
          }
          const descriptor = descriptors[key];
          if (key === "length") {
            if (
              !("value" in descriptor) ||
              descriptor.enumerable ||
              descriptor.configurable ||
              descriptor.writable !== true
            ) {
              throw invalidNestedIdentity(`${path} has a non-standard array length property`);
            }
            continue;
          }
          if (!isArrayIndex(key, item.length)) {
            throw invalidNestedIdentity(`${path} array contains custom property ${JSON.stringify(key)}`);
          }
          assertEnumerableDataDescriptor(descriptor, `${path}[${key}]`);
        }
        return [
          "array",
          Array.from({ length: item.length }, (_, index) => {
            const descriptor = descriptors[String(index)];
            return descriptor ? encode(descriptor.value, `${path}[${index}]`) : ["hole"];
          }),
        ];
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== null) assertNativeDataPrototype(item, "Object", path);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const encoded: Array<[string, unknown]> = [];
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") {
          throw invalidNestedIdentity(`${path} object contains unsupported symbol properties`);
        }
        const descriptor = descriptors[key];
        assertEnumerableDataDescriptor(descriptor, `${path}.${key}`);
        encoded.push([key, encode(descriptor.value, `${path}.${key}`)]);
      }
      encoded.sort(([left], [right]) => left.localeCompare(right));
      return ["object", encoded];
    } finally {
      ancestors.delete(item);
    }
  };
  return JSON.stringify(encode(value, rootPath));
}

function snapshotNestedWorkflowArgs(
  value: unknown,
  retainedWorktrees: RetainedWorktreeRegistry,
): { value: unknown; carriesRetainedWorktree: boolean } {
  const ancestors = new WeakSet<object>();
  let carriesRetainedWorktree = false;
  const clone = (item: unknown, path: string): unknown => {
    if (
      item === null ||
      item === undefined ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) {
      return item;
    }
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
      throw invalidNestedIdentity(`${path} contains unsupported ${typeof item}; pass data-only JSON-like values`);
    }
    if (typeof item !== "object") {
      throw invalidNestedIdentity(`${path} contains unsupported value type ${typeof item}`);
    }

    const retainedIdentity = retainedWorktrees.canonicalIdentity(item);
    if (retainedIdentity !== undefined) {
      carriesRetainedWorktree = true;
      return item;
    }
    if (ancestors.has(item)) {
      throw invalidNestedIdentity(`${path} is cyclic; nested workflow args must be acyclic`);
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        assertNativeDataPrototype(item, "Array", path);
        const descriptors = Object.getOwnPropertyDescriptors(item);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key === "symbol") {
            throw invalidNestedIdentity(`${path} array contains unsupported symbol properties`);
          }
          const descriptor = descriptors[key];
          if (key === "length") {
            if (
              !("value" in descriptor) ||
              descriptor.enumerable ||
              descriptor.configurable ||
              descriptor.writable !== true
            ) {
              throw invalidNestedIdentity(`${path} has a non-standard array length property`);
            }
            continue;
          }
          if (!isArrayIndex(key, item.length)) {
            throw invalidNestedIdentity(`${path} array contains custom property ${JSON.stringify(key)}`);
          }
          assertEnumerableDataDescriptor(descriptor, `${path}[${key}]`);
        }
        const result = new Array<unknown>(item.length);
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (descriptor) result[index] = clone(descriptor.value, `${path}[${index}]`);
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== null) assertNativeDataPrototype(item, "Object", path);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const result: Record<string, unknown> = prototype === null ? Object.create(null) : {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") {
          throw invalidNestedIdentity(`${path} object contains unsupported symbol properties`);
        }
        const descriptor = descriptors[key];
        assertEnumerableDataDescriptor(descriptor, `${path}.${key}`);
        result[key] = clone(descriptor.value, `${path}.${key}`);
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };

  return { value: clone(value, "workflow args"), carriesRetainedWorktree };
}

function assertNativeDataPrototype(item: object, expectedName: "Array" | "Object", path: string): void {
  const prototype = Object.getPrototypeOf(item);
  const constructorDescriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
  const prototypeConstructor =
    constructorDescriptor && "value" in constructorDescriptor ? constructorDescriptor.value : undefined;
  const source =
    typeof prototypeConstructor === "function" ? Function.prototype.toString.call(prototypeConstructor) : "";
  if (
    !constructorDescriptor ||
    !("value" in constructorDescriptor) ||
    constructorDescriptor.enumerable ||
    typeof prototypeConstructor !== "function" ||
    prototypeConstructor.name !== expectedName ||
    prototypeConstructor.prototype !== prototype ||
    !source.includes("[native code]")
  ) {
    throw invalidNestedIdentity(`${path} must use a plain ${expectedName.toLowerCase()} data prototype`);
  }
}

function assertEnumerableDataDescriptor(descriptor: PropertyDescriptor, path: string): void {
  if (!("value" in descriptor)) {
    throw invalidNestedIdentity(`${path} is an accessor; getters and setters are not allowed`);
  }
  if (!descriptor.enumerable) {
    throw invalidNestedIdentity(`${path} is non-enumerable; only enumerable data properties are allowed`);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function invalidNestedIdentity(message: string): WorkflowError {
  return new WorkflowError(`Invalid nested workflow args: ${message}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
  });
}

function budgetError(exhaustion: BudgetExhaustion, usage: TokenUsage): WorkflowError {
  const subject =
    exhaustion.scope === "phase" ? `phase "${exhaustion.phase}" token sub-budget` : "workflow token budget";
  return new WorkflowError(
    `${subject} exhausted at ${exhaustion.spent} tokens (best-effort ceiling ${exhaustion.limit}, overshoot ${exhaustion.overshoot})`,
    WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
    {
      recoverable: false,
      details: { exhaustion, usage: structuredClone(usage) },
      usage: structuredClone(usage),
      overshoot: exhaustion.overshoot,
    },
  );
}
