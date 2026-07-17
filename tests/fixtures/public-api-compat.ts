import type { ManagedRun, NestedWorkflowOptions, SharedRuntime, WorkflowRunResult } from "../../src/index.js";

const runtime: SharedRuntime = {
  limiter: async <T>(fn: () => Promise<T>) => fn(),
  agentCount: 0,
  spent: 0,
  tokenUsage: {
    input: 0,
    output: 0,
    total: 0,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  depth: 0,
};

const historicalResult: WorkflowRunResult = {
  meta: { name: "legacy", description: "legacy consumer" },
  result: null,
  logs: [],
  phases: [],
  agentCount: 0,
  durationMs: 0,
  tokenUsage: {
    input: 10,
    output: 5,
    total: 15,
    cost: 0.01,
  },
};

const historicalManagedRun: ManagedRun = {
  runId: "legacy-run",
  status: "paused",
  snapshot: {
    name: "legacy",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  },
  controller: new AbortController(),
  startedAt: new Date(0),
  script: "export const meta = { name: 'legacy', description: 'legacy' }\nreturn null",
  journal: [],
  background: false,
};

const nestedOptions: NestedWorkflowOptions = { key: "stable-child" };
const spent: number = runtime.spent;
const depth: number = runtime.depth;
const total: number = runtime.tokenUsage.total;
void [historicalResult, historicalManagedRun, nestedOptions, spent, depth, total];
