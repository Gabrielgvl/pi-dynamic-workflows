import { randomUUID } from "node:crypto";

export const TOKEN_USAGE_SCHEMA_VERSION = 1;
export const RUNTIME_CHECKPOINT_SCHEMA_VERSION = 2;

export type UsageProvenance = "measured" | "estimated" | "legacy-unclassified";

/** Provider/session usage for one cumulative observation or settled attempt. */
export interface UsageSample {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported reasoning tokens. They are already included in output. */
  reasoning?: number;
  provenance: UsageProvenance;
}

/**
 * Runtime token telemetry. The top-level fields are the long-standing public
 * compatibility surface. `accounting` makes provenance and overlapping provider
 * dimensions explicit without changing those totals.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
  schemaVersion: typeof TOKEN_USAGE_SCHEMA_VERSION;
  accounting: {
    measured: number;
    estimated: number;
    legacyUnclassified: number;
    /** Tokens represented by replayed results; replay never increments `total`. */
    journalReplay: number;
    reasoning: {
      tokens: number;
      includedInOutput: true;
    };
    providerCache: {
      read: number;
      write: number;
    };
  };
}

export type LegacyTokenUsage = Pick<TokenUsage, "input" | "output" | "total"> &
  Partial<Pick<TokenUsage, "cost" | "cacheRead" | "cacheWrite">>;

export function createTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    total: 0,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
    schemaVersion: TOKEN_USAGE_SCHEMA_VERSION,
    accounting: {
      measured: 0,
      estimated: 0,
      legacyUnclassified: 0,
      journalReplay: 0,
      reasoning: { tokens: 0, includedInOutput: true },
      providerCache: { read: 0, write: 0 },
    },
  };
}

export function addUsageSample(target: TokenUsage, sample: UsageSample): TokenUsage {
  target.input += sample.input;
  target.output += sample.output;
  target.total += sample.total;
  target.cost += sample.cost;
  target.cacheRead += sample.cacheRead;
  target.cacheWrite += sample.cacheWrite;

  if (sample.provenance === "measured") target.accounting.measured += sample.total;
  else if (sample.provenance === "estimated") target.accounting.estimated += sample.total;
  else target.accounting.legacyUnclassified += sample.total;

  target.accounting.reasoning.tokens += sample.reasoning ?? 0;
  target.accounting.providerCache.read += sample.cacheRead;
  target.accounting.providerCache.write += sample.cacheWrite;
  return target;
}

export function addJournalReplay(target: TokenUsage, tokens: number): TokenUsage {
  target.accounting.journalReplay += Math.max(0, tokens);
  return target;
}

export function mergeTokenUsage(target: TokenUsage, source: TokenUsage): TokenUsage {
  target.input += source.input;
  target.output += source.output;
  target.total += source.total;
  target.cost += source.cost;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.accounting.measured += source.accounting.measured;
  target.accounting.estimated += source.accounting.estimated;
  target.accounting.legacyUnclassified += source.accounting.legacyUnclassified;
  target.accounting.journalReplay += source.accounting.journalReplay;
  target.accounting.reasoning.tokens += source.accounting.reasoning.tokens;
  target.accounting.providerCache.read += source.accounting.providerCache.read;
  target.accounting.providerCache.write += source.accounting.providerCache.write;
  return target;
}

export function restoreTokenUsage(value?: LegacyTokenUsage | TokenUsage): TokenUsage {
  if (!value) return createTokenUsage();
  if ("schemaVersion" in value && value.schemaVersion === TOKEN_USAGE_SCHEMA_VERSION && "accounting" in value) {
    return structuredClone(value as TokenUsage);
  }

  const restored = createTokenUsage();
  addUsageSample(restored, {
    input: value.input,
    output: value.output,
    total: value.total,
    cost: value.cost ?? 0,
    cacheRead: value.cacheRead ?? 0,
    cacheWrite: value.cacheWrite ?? 0,
    provenance: "legacy-unclassified",
  });
  return restored;
}

export type AttemptStatus = "running" | "succeeded" | "failed" | "timed_out" | "aborted";

export interface AttemptCheckpoint {
  attempt: number;
  /** Unique live generation. Absent only on checkpoints written by older versions. */
  attemptId?: string;
  /** Identity hash of the call revision this attempt executed. */
  callHash?: string;
  /** Display title retained for UI and error messages. */
  phase?: string;
  /** Stable hierarchical phase identity used for budget accounting. */
  phaseBudgetKey?: string;
  /** Stable accounting identity for this logical workflow invocation. */
  accountingScopeKey?: string;
  /** Stable logical child call identity, independent of its wrapper's physical position. */
  accountingCallKey?: string;
  /** Ephemeral runtime invocation that owns this attempt's lifetime. */
  ownerScopeKey?: string;
  status: AttemptStatus;
  usage: TokenUsage;
  error?: string;
}

export interface PhaseBudgetCheckpoint {
  budget: number;
  charged: number;
  warned: boolean;
  /** Display title; the containing record key is the stable hierarchical identity. */
  title?: string;
}

export interface RuntimeCheckpoint {
  /** Schema 2 adds stable per-accounting-scope aggregates. */
  schemaVersion: 1 | typeof RUNTIME_CHECKPOINT_SCHEMA_VERSION;
  usage: TokenUsage;
  phaseBudgets: Record<string, PhaseBudgetCheckpoint>;
  attempts: Record<string, AttemptCheckpoint[]>;
  /** Absent on schema-1 checkpoints; legacy usage is never inferred into a scope. */
  scopeUsage?: Record<string, TokenUsage>;
}

export interface BudgetExhaustion {
  scope: "run" | "phase";
  phase?: string;
  /** Stable hierarchical identity for phase exhaustion. */
  phaseKey?: string;
  limit: number;
  spent: number;
  overshoot: number;
}

interface ActiveAttempt {
  controller: AbortController;
  checkpoint: AttemptCheckpoint;
  lastSample?: UsageSample;
}

interface ExhaustedAttempt extends BudgetExhaustion {
  phaseBudgetKey?: string;
  /** Final telemetry may settle successfully; the run-level final gate reports it. */
  deferUntilRunEnd?: boolean;
}

interface UsageControllerOptions {
  tokenBudget?: number | null;
  checkpoint?: RuntimeCheckpoint;
  onChange?: (checkpoint: RuntimeCheckpoint) => void;
}

/** Central cumulative accounting and best-effort budget controller. */
export class UsageController {
  readonly usage: TokenUsage;
  private readonly tokenBudget: number | null;
  private readonly phaseBudgets = new Map<string, PhaseBudgetCheckpoint>();
  private readonly attempts: Record<string, AttemptCheckpoint[]>;
  private readonly scopeUsage = new Map<string, TokenUsage>();
  /** Active callbacks are keyed by attempt generation, never by logical call key. */
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly exhaustedAttempts = new Map<string, ExhaustedAttempt>();
  /** Admission failures remain terminal even when workflow code catches them. */
  private observedAdmissionFailure?: BudgetExhaustion;
  private readonly onChange?: (checkpoint: RuntimeCheckpoint) => void;

  constructor(options: UsageControllerOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? null;
    this.usage = restoreTokenUsage(options.checkpoint?.usage);
    this.attempts = structuredClone(options.checkpoint?.attempts ?? {});
    if (options.checkpoint?.schemaVersion === RUNTIME_CHECKPOINT_SCHEMA_VERSION) {
      for (const [scopeKey, usage] of Object.entries(options.checkpoint.scopeUsage ?? {})) {
        this.scopeUsage.set(scopeKey, restoreTokenUsage(usage));
      }
    }
    for (const [phase, state] of Object.entries(options.checkpoint?.phaseBudgets ?? {})) {
      this.phaseBudgets.set(phase, { ...state });
    }
    this.onChange = options.onChange;
  }

  declarePhase(key: string, title: string, budget: number): void {
    let existing = this.phaseBudgets.get(key);
    if (existing?.title !== undefined && existing.title !== title) {
      // A title mismatch is never evidence that two phases are the same. Start a
      // fresh checkpoint rather than transferring a charged budget by key alone.
      this.phaseBudgets.set(key, { budget, charged: 0, warned: false, title });
      this.changed();
      return;
    }

    if (!existing) {
      const legacyDisplayKey = this.phaseBudgets.get(title);
      const ordinalMatches = this.legacyOrdinalMatches(key, title);
      const nestedScope = key.includes("/workflow:") || key.includes("/workflow-key:");
      if (legacyDisplayKey && legacyDisplayKey.title === undefined && ordinalMatches.length === 0 && !nestedScope) {
        this.phaseBudgets.delete(title);
        existing = legacyDisplayKey;
        this.phaseBudgets.set(key, existing);
      } else if (ordinalMatches.length === 1) {
        const [legacyKey, legacy] = ordinalMatches[0];
        this.phaseBudgets.delete(legacyKey);
        existing = legacy;
        this.phaseBudgets.set(key, existing);
      }
    }

    if (existing) {
      existing.budget = budget;
      existing.title = title;
    } else if (!this.phaseBudgets.has(key)) {
      this.phaseBudgets.set(key, { budget, charged: 0, warned: false, title });
    }
    this.changed();
  }

  admissionFailure(phaseBudgetKey?: string): BudgetExhaustion | undefined {
    let failure: BudgetExhaustion | undefined;
    if (this.tokenBudget !== null && this.usage.total >= this.tokenBudget) {
      failure = this.exhaustion("run", this.tokenBudget, this.usage.total);
    } else if (phaseBudgetKey) {
      const state = this.phaseBudgets.get(phaseBudgetKey);
      if (state && state.charged >= state.budget) {
        failure = this.exhaustion("phase", state.budget, state.charged, state.title, phaseBudgetKey);
      }
    }
    if (failure) this.observedAdmissionFailure = failure;
    return failure;
  }

  startAttempt(
    key: string,
    attempt: number,
    callHash: string,
    phase: string | undefined,
    controller: AbortController,
    phaseBudgetKey?: string,
    accountingScopeKey?: string,
    ownerScopeKey?: string,
    accountingCallKey?: string,
  ): string {
    const attemptId = randomUUID();
    const checkpoint: AttemptCheckpoint = {
      attempt,
      attemptId,
      callHash,
      phase,
      phaseBudgetKey,
      accountingScopeKey,
      accountingCallKey,
      ownerScopeKey,
      status: "running",
      usage: createTokenUsage(),
    };
    const attempts = this.attempts[key] ?? [];
    attempts.push(checkpoint);
    this.attempts[key] = attempts;
    this.active.set(attemptId, { controller, checkpoint });
    this.changed();
    return attemptId;
  }

  updateAttempt(
    attemptId: string,
    sample: UsageSample,
    cancelOnExhaustion: boolean,
    excludeAttemptFromCancellation = false,
  ): void {
    const active = this.active.get(attemptId);
    if (!active) return;
    const delta = usageDelta(active.lastSample, sample);
    active.lastSample = { ...sample };
    if (
      delta.total === 0 &&
      delta.input === 0 &&
      delta.output === 0 &&
      delta.cacheRead === 0 &&
      delta.cacheWrite === 0 &&
      delta.cost === 0 &&
      (delta.reasoning ?? 0) === 0
    ) {
      return;
    }

    addUsageSample(active.checkpoint.usage, delta);
    addUsageSample(this.usage, delta);
    if (active.checkpoint.accountingScopeKey) {
      let scoped = this.scopeUsage.get(active.checkpoint.accountingScopeKey);
      if (!scoped) {
        scoped = createTokenUsage();
        this.scopeUsage.set(active.checkpoint.accountingScopeKey, scoped);
      }
      addUsageSample(scoped, delta);
    }
    if (active.checkpoint.phaseBudgetKey) {
      const phase = this.phaseBudgets.get(active.checkpoint.phaseBudgetKey);
      if (phase) {
        phase.charged += delta.total;
        if (!phase.warned && phase.charged >= phase.budget * 0.8) phase.warned = true;
      }
    }

    if (cancelOnExhaustion) {
      this.cancelExhaustedAttempts(excludeAttemptFromCancellation ? attemptId : undefined);
    }
    this.changed();
  }

  settleAttempt(
    attemptId: string,
    status: Exclude<AttemptStatus, "running">,
    options: { error?: string; estimate?: UsageSample } = {},
  ): TokenUsage {
    const active = this.active.get(attemptId);
    if (!active) return createTokenUsage();
    if (active.checkpoint.usage.total === 0 && options.estimate) {
      this.updateAttempt(attemptId, options.estimate, false);
    }
    active.checkpoint.status = status;
    active.checkpoint.error = options.error;
    this.active.delete(attemptId);
    this.changed();
    return structuredClone(active.checkpoint.usage);
  }

  exhaustionFor(attemptId: string, includeDeferred = true): BudgetExhaustion | undefined {
    const recorded = this.exhaustedAttempts.get(attemptId);
    if (!recorded || (!includeDeferred && recorded.deferUntilRunEnd)) return undefined;
    if (recorded.scope === "run") {
      return this.exhaustion("run", recorded.limit, this.usage.total);
    }
    const phase = recorded.phaseBudgetKey ? this.phaseBudgets.get(recorded.phaseBudgetKey) : undefined;
    return this.exhaustion(
      "phase",
      recorded.limit,
      phase?.charged ?? recorded.spent,
      phase?.title ?? recorded.phase,
      recorded.phaseBudgetKey,
    );
  }

  currentExhaustion(exhaustion: BudgetExhaustion): BudgetExhaustion {
    if (exhaustion.scope === "run") {
      return this.exhaustion("run", exhaustion.limit, this.usage.total);
    }
    const phase = exhaustion.phaseKey ? this.phaseBudgets.get(exhaustion.phaseKey) : undefined;
    return this.exhaustion(
      "phase",
      exhaustion.limit,
      phase?.charged ?? exhaustion.spent,
      phase?.title ?? exhaustion.phase,
      exhaustion.phaseKey,
    );
  }

  priorAttemptUsage(
    key: string,
    callHash: string,
    accountingCallKey?: string,
    accountingScopeKey?: string,
  ): TokenUsage {
    const usage = createTokenUsage();
    for (const attempt of this.attemptsForIdentity(key, accountingCallKey, accountingScopeKey)) {
      // Hash-less checkpoints are a compatibility fallback from the initial
      // accounting schema and are treated as belonging to the stable call key.
      if (attempt.callHash === undefined || attempt.callHash === callHash) mergeTokenUsage(usage, attempt.usage);
    }
    return usage;
  }

  nextAttemptNumber(key: string, accountingCallKey?: string, accountingScopeKey?: string): number {
    return this.attemptsForIdentity(key, accountingCallKey, accountingScopeKey).length + 1;
  }

  usageForScope(accountingScopeKey: string): TokenUsage {
    return structuredClone(this.scopeUsage.get(accountingScopeKey) ?? createTokenUsage());
  }

  terminalExhaustion(accountingScopeKey: string): BudgetExhaustion | undefined {
    if (this.observedAdmissionFailure) return this.currentExhaustion(this.observedAdmissionFailure);
    for (const exhausted of this.exhaustedAttempts.values()) {
      const current = this.currentExhaustion(exhausted);
      if (
        current.scope === "run" ||
        current.phaseKey?.startsWith(`${accountingScopeKey}/phase:`) ||
        current.phaseKey?.startsWith(`${accountingScopeKey}/workflow:`) ||
        current.phaseKey?.startsWith(`${accountingScopeKey}/workflow-key:`)
      ) {
        return current;
      }
    }
    return undefined;
  }

  addReplay(tokens: number): void {
    addJournalReplay(this.usage, tokens);
    this.changed();
  }

  checkpoint(): RuntimeCheckpoint {
    return {
      schemaVersion: RUNTIME_CHECKPOINT_SCHEMA_VERSION,
      usage: structuredClone(this.usage),
      phaseBudgets: Object.fromEntries([...this.phaseBudgets.entries()].map(([phase, state]) => [phase, { ...state }])),
      attempts: structuredClone(this.attempts),
      scopeUsage: Object.fromEntries(
        [...this.scopeUsage.entries()].map(([scopeKey, usage]) => [scopeKey, structuredClone(usage)]),
      ),
    };
  }

  private attemptsForIdentity(
    key: string,
    accountingCallKey?: string,
    accountingScopeKey?: string,
  ): AttemptCheckpoint[] {
    const positional = this.attempts[key] ?? [];
    if (!accountingScopeKey && !accountingCallKey) return positional;
    if (accountingCallKey) {
      const stable = Object.values(this.attempts)
        .flat()
        .filter((attempt) => attempt.accountingCallKey === accountingCallKey);
      if (stable.length > 0) return stable;
    }
    if (!accountingScopeKey) return [];

    // Schema-1 checkpoints may know the owning keyed workflow scope without a
    // per-call accounting key. Only positional attempts explicitly attributed
    // to this same scope may seed this logical row. Unattributed usage remains
    // part of the run-level total but does not fabricate attempts or row tokens.
    return positional.filter(
      (attempt) => attempt.accountingCallKey === undefined && attempt.accountingScopeKey === accountingScopeKey,
    );
  }

  private legacyOrdinalMatches(key: string, title: string): Array<[string, PhaseBudgetCheckpoint]> {
    const marker = "/phase:";
    const markerIndex = key.lastIndexOf(marker);
    if (markerIndex < 0) return [];
    const prefix = key.slice(0, markerIndex + marker.length);
    return [...this.phaseBudgets.entries()].filter(
      ([candidateKey, state]) =>
        candidateKey !== key &&
        candidateKey.startsWith(prefix) &&
        /^\d+$/.test(candidateKey.slice(prefix.length)) &&
        state.title === title,
    );
  }

  private cancelExhaustedAttempts(excludedAttemptId?: string): void {
    const runFailure =
      this.tokenBudget !== null && this.usage.total >= this.tokenBudget
        ? this.exhaustion("run", this.tokenBudget, this.usage.total)
        : undefined;
    for (const [attemptId, active] of this.active) {
      const phaseState = active.checkpoint.phaseBudgetKey
        ? this.phaseBudgets.get(active.checkpoint.phaseBudgetKey)
        : undefined;
      const phaseFailure =
        phaseState && phaseState.charged >= phaseState.budget
          ? this.exhaustion(
              "phase",
              phaseState.budget,
              phaseState.charged,
              phaseState.title,
              active.checkpoint.phaseBudgetKey,
            )
          : undefined;
      const failure = runFailure ?? phaseFailure;
      if (!failure) continue;
      // Reaching a ceiling exactly on the only successfully settling source is
      // allowed to complete. Overshoot, cancelled siblings, or any subsequent
      // admission remain terminal and are reported honestly.
      if (attemptId === excludedAttemptId && failure.overshoot === 0 && this.active.size === 1) continue;
      this.exhaustedAttempts.set(attemptId, {
        ...failure,
        phaseBudgetKey: active.checkpoint.phaseBudgetKey,
        deferUntilRunEnd: attemptId === excludedAttemptId,
      });
      if (attemptId !== excludedAttemptId) active.controller.abort(failure);
    }
  }

  private exhaustion(
    scope: "run" | "phase",
    limit: number,
    spent: number,
    phase?: string,
    phaseKey?: string,
  ): BudgetExhaustion {
    return {
      scope,
      limit,
      spent,
      overshoot: Math.max(0, spent - limit),
      ...(phase ? { phase } : {}),
      ...(phaseKey ? { phaseKey } : {}),
    };
  }

  private changed(): void {
    this.onChange?.(this.checkpoint());
  }
}

function usageDelta(previous: UsageSample | undefined, current: UsageSample): UsageSample {
  if (!previous) return { ...current };
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    total: Math.max(0, current.total - previous.total),
    cost: Math.max(0, current.cost - previous.cost),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    reasoning: current.reasoning === undefined ? undefined : Math.max(0, current.reasoning - (previous.reasoning ?? 0)),
    provenance: current.provenance,
  };
}
