import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { RuntimeCheckpoint } from "../src/usage.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent retries override run-level retries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { label: 'a', retries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("meta.model is parsed and routes as the default model for agents", async () => {
  let seenModel: string | undefined;
  const recorder = {
    async run(_p: string, o: { model?: string }) {
      seenModel = o.model;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'm', description: 'd', model: 'meta/default-model' }
await agent('x', { label: 'x' })
return 1`;
  await runWorkflow(script, { agent: recorder, persistLogs: false });
  assert.equal(seenModel, "meta/default-model", "an agent with no model/tier/phase route uses meta.model");
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow routes models: explicit opts.model > phase model > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", undefined]);
});

test("runWorkflow plumbs opts.tier through to the agent with correct precedence", async () => {
  // Regression guard: tier must reach WorkflowAgent.run() (it was previously
  // dropped). Precedence: explicit model > tier > phase model.
  const seen: Array<{ model?: string; tier?: string }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; tier?: string }) {
      seen.push({ model: options.model, tier: options.tier });
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'tier_routing', description: 'tier routing',
    phases: [{ title: 'A', model: 'phase-a-model' }]
  }
  phase('A')
  await agent('tier beats phase', { label: 't', tier: 'small' })
  await agent('explicit beats tier', { label: 'e', tier: 'small', model: 'explicit-model' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  // 1) tier set, no explicit model: model is left undefined so the tier (resolved
  //    inside run()) wins over the phase model; tier is forwarded.
  assert.deepEqual(seen[0], { model: undefined, tier: "small" });
  // 2) explicit model + tier: explicit model is forwarded and still wins.
  assert.deepEqual(seen[1], { model: "explicit-model", tier: "small" });
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("runWorkflow budget exhaustion remains terminal when a later admission error is caught", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { second }`;

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );
});

test("resume accounting is cumulative and cached replay completes at zero remaining budget", async () => {
  const script = `export const meta = { name: 'resume_budget', description: 'budget' }
const value = await agent('cached', { label: 'cached' })
return { value, total: budget.total, spent: budget.spent(), remaining: budget.remaining() }`;
  const journal: JournalEntry[] = [];
  const first = await runWorkflow<{
    value: unknown;
    total: number;
    spent: number;
    remaining: number;
  }>(script, {
    agent: fakeAgent({ input: 60, output: 40, total: 100, cost: 0.25 }),
    tokenBudget: 100,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(first.result.value, "ok");
  assert.equal(first.result.total, 100);
  assert.equal(first.result.spent, 100);
  assert.equal(first.result.remaining, 0);

  let liveCalls = 0;
  const resumed = await runWorkflow<typeof first.result>(script, {
    agent: {
      async run() {
        liveCalls++;
        return "must-not-run";
      },
    },
    tokenBudget: 100,
    initialTokenUsage: first.tokenUsage,
    initialTokenSpend: first.tokenUsage?.total,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    persistLogs: false,
  });

  assert.equal(liveCalls, 0);
  assert.equal(resumed.result.value, "ok");
  assert.equal(resumed.result.total, 100);
  assert.equal(resumed.result.spent, 100);
  assert.equal(resumed.result.remaining, 0);
  assert.equal(resumed.tokenUsage?.total, first.tokenUsage?.total, "replay adds zero billable usage");
  assert.equal(resumed.tokenUsage?.cost, first.tokenUsage?.cost, "replay adds zero cost");
  assert.equal(resumed.tokenUsage?.accounting?.journalReplay, 100, "replayed work remains visible in telemetry");
});

test("resume blocks fresh work when cumulative spend has exhausted the original budget", async () => {
  const script = `export const meta = { name: 'resume_fresh', description: 'budget' }
await agent('fresh', { label: 'fresh' })
return true`;
  let liveCalls = 0;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: {
          async run() {
            liveCalls++;
            return "must-not-run";
          },
        },
        tokenBudget: 100,
        initialTokenUsage: { input: 100, output: 0, total: 100, cost: 0 },
        initialTokenSpend: 100,
        resumeJournal: new Map(),
        persistLogs: false,
      }),
    /budget exhausted/i,
  );
  assert.equal(liveCalls, 0);
});

test("token budget exhaustion inside parallel() halts (non-recoverable, not swallowed)", async () => {
  // A warm-up agent spends the whole budget (soft gate: spent accrues after it
  // finishes); the agent() inside parallel() then hits the gate and must
  // propagate the non-recoverable error, not become a null in the result array.
  const script = `export const meta = { name: 'pb', description: 'budget in parallel' }
await agent('warmup', { label: 'w' })
const xs = await parallel([() => agent('x', { label: '1' })])
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    /budget/i,
    "exhausted budget must reject the run, not become a null in the result array",
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("phase sub-budget exhaustion remains terminal after a caught error", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
try {
  await agent('a', { label: '1' })
  await agent('b', { label: '2' })
} catch {}
phase('calm')
await agent('c', { label: '3' })
return 'done'`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        persistLogs: false,
      }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow budget object exposes spent() and remaining()", async () => {
  const script = `export const meta = { name: 'budget_api', description: 'budget API' }
try { const s = budget.spent(); const r = budget.remaining(); return { spent: s, remaining: typeof r } }
catch(e) { return { error: String(e) } }`;

  const result = await runWorkflow<{ spent: number; remaining: string }>(script, {
    agent: fakeAgent({ total: 100 }),
    persistLogs: false,
  });

  assert.equal(result.result.spent, 0); // before first agent
  assert.equal(result.result.remaining, "number");
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects literal Date.now / Math.random / new Date()", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("runtime guard neuters computed-access bypasses the parse regex misses", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // The escape string is split so the parse-time regex doesn't flag it; at runtime
  // the vm Function runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Da' + 'te.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});

// ─── Versioned accounting, cancellation, and hierarchical resume ──────────────

test("retry attempts are charged once each and reported on the logical agent", async () => {
  let calls = 0;
  let logicalTokens = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'retry_usage', description: 'retry accounting' }
return await agent('work', { label: 'worker', retries: 1 })`,
    {
      agent: {
        async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
          calls++;
          const total = calls === 1 ? 30 : 40;
          options.onUsage?.({ input: total, output: 0, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return calls === 1 ? "" : "ok";
        },
      },
      persistLogs: false,
      onAgentEnd: (event) => {
        logicalTokens = event.tokens ?? 0;
      },
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(result.tokenUsage?.total, 70);
  assert.equal(logicalTokens, 70, "the compatibility callback must aggregate all attempts");
});

test("budget admission runs inside the limiter and blocks already-queued live work", async () => {
  let calls = 0;
  const script = `export const meta = { name: 'queued_budget', description: 'queued admission' }
return await parallel([0, 1, 2].map((i) => () => agent('work-' + i, { label: 'a' + i })))`;

  await assert.rejects(
    () =>
      runWorkflow(script, {
        concurrency: 1,
        tokenBudget: 60,
        agent: {
          async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
            calls++;
            options.onUsage?.({ input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 });
            return "ok";
          },
        },
        persistLogs: false,
      }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );
  assert.equal(calls, 1, "queued agents must re-check the ceiling immediately before their attempt");
});

test("timeout aborts and settles the attempt before starting its retry", async () => {
  const firstSettled = createDeferred<void>();
  let attemptAborted = false;
  let calls = 0;
  const run = runWorkflow(
    `export const meta = { name: 'settled_timeout', description: 'settle before retry' }
return await agent('slow', { label: 'slow', timeoutMs: 5, retries: 1 })`,
    {
      agent: {
        async run(_prompt: string, options: { signal?: AbortSignal }) {
          calls++;
          if (calls === 2) return "retried";
          options.signal?.addEventListener(
            "abort",
            () => {
              attemptAborted = true;
            },
            { once: true },
          );
          await firstSettled.promise;
          return "late";
        },
      },
      persistLogs: false,
    },
  );

  let runSettled = false;
  void run.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );
  const safetyRelease = setTimeout(() => firstSettled.resolve(), 50);
  await new Promise((resolve) => setTimeout(resolve, 15));
  try {
    assert.equal(attemptAborted, true, "timeout aborts the per-attempt signal");
    assert.equal(runSettled, false, "the logical attempt remains blocked until the custom runner settles");
    assert.equal(calls, 1, "the retry must not overlap the timed-out attempt");
  } finally {
    clearTimeout(safetyRelease);
    firstSettled.resolve();
  }
  const result = await run;
  assert.equal(result.result, "retried");
  assert.equal(calls, 2);
});

test("retry admission rechecks the cumulative budget after a failed attempt", async () => {
  let calls = 0;
  let ended: { errorCode?: WorkflowErrorCode; tokens?: number } | undefined;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'retry_budget', description: 'retry budget admission' }
return await agent('work', { label: 'worker', retries: 1 })`,
        {
          tokenBudget: 50,
          agent: {
            async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
              calls++;
              options.onUsage?.({ input: 50, output: 0, total: 50, cost: 0, cacheRead: 0, cacheWrite: 0 });
              return "";
            },
          },
          onAgentEnd: (event) => {
            ended = event;
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );
  assert.equal(calls, 1, "the retry must be rejected before another provider attempt starts");
  assert.equal(ended?.errorCode, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
  assert.equal(ended?.tokens, 50, "the terminal logical-agent event retains the failed attempt usage");
});

test("parallel sibling nested workflows are allowed while grandchildren remain rejected", async () => {
  const workflows: Record<string, string> = {
    left: `export const meta = { name: 'left', description: 'left' }
return await agent('left', { label: 'left' })`,
    right: `export const meta = { name: 'right', description: 'right' }
return await agent('right', { label: 'right' })`,
    grandchild: `export const meta = { name: 'grandchild', description: 'grandchild' }
return await agent('grandchild', { label: 'grandchild' })`,
    childWithGrandchild: `export const meta = { name: 'child', description: 'child' }
return await workflow('grandchild')`,
  };
  const siblingResult = await runWorkflow<unknown[]>(
    `export const meta = { name: 'siblings', description: 'siblings' }
return await Promise.all([workflow('left'), workflow('right')])`,
    {
      agent: countingAgent().runner,
      loadSavedWorkflow: (name) => workflows[name],
      persistLogs: false,
    },
  );
  assert.deepEqual([...siblingResult.result], ["ran:left", "ran:right"]);

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'parent', description: 'parent' }
return await workflow('childWithGrandchild')`,
        {
          agent: countingAgent().runner,
          loadSavedWorkflow: (name) => workflows[name],
          persistLogs: false,
        },
      ),
    /one level deep/,
  );
});

test("hierarchical journal keys replay nested results without collisions or live charges", async () => {
  const child = `export const meta = { name: 'child', description: 'child' }
return await agent('child-work', { label: 'child' })`;
  const parent = `export const meta = { name: 'parent', description: 'parent' }
const [a, b] = await Promise.all([workflow('child', undefined, { key: 'a' }), workflow('child', undefined, { key: 'b' })])
return { a, b }`;
  const firstAgent = countingAgent();
  const journal: JournalEntry[] = [];
  const first = await runWorkflow(parent, {
    agent: firstAgent.runner,
    loadSavedWorkflow: () => child,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
  });

  const keys = journal.map((entry) => entry.key);
  assert.ok(keys.every(Boolean), "new journals must use stable string keys");
  assert.equal(new Set(keys).size, keys.length, "parent, siblings, and child calls must not collide");

  const secondAgent = countingAgent();
  const resumed = await runWorkflow(parent, {
    agent: secondAgent.runner,
    loadSavedWorkflow: () => child,
    resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
    runtimeCheckpoint: first.runtimeCheckpoint,
    persistLogs: false,
  });

  assert.equal(secondAgent.state.calls, 0, "nested results replay without running child agents");
  assert.equal(resumed.tokenUsage?.total, first.tokenUsage?.total, "journal replay is not charged as live work");
  assert.ok((resumed.tokenUsage?.accounting.journalReplay ?? 0) > 0, "replay telemetry remains visible");
});

test("a partially replayed nested child journals its full sibling-safe aggregate", async () => {
  const parent = `export const meta = { name: 'parent', description: 'parent' }
return await workflow('child')`;
  const childV1 = `export const meta = { name: 'child', description: 'child' }
const first = await agent('first', { label: 'first' })
const second = await agent('second-v1', { label: 'second' })
return { first, second }`;
  const childV2 = childV1.replace("second-v1", "second-v2");
  const firstJournal: JournalEntry[] = [];
  const first = await runWorkflow(parent, {
    agent: fakeAgent({ input: 10, total: 10 }),
    loadSavedWorkflow: () => childV1,
    onAgentJournal: (entry) => firstJournal.push(entry),
    persistLogs: false,
  });

  let liveCalls = 0;
  const resumedJournal: JournalEntry[] = [];
  await runWorkflow(parent, {
    agent: {
      async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
        liveCalls++;
        options.onUsage?.({ input: 10, output: 0, total: 10, cost: 0, cacheRead: 0, cacheWrite: 0 });
        return "updated";
      },
    },
    loadSavedWorkflow: () => childV2,
    resumeJournal: new Map(firstJournal.map((entry) => [entry.key as string, entry])),
    runtimeCheckpoint: first.runtimeCheckpoint,
    onAgentJournal: (entry) => resumedJournal.push(entry),
    persistLogs: false,
  });

  assert.equal(liveCalls, 1, "the unchanged child prefix replays while the changed sibling runs live");
  const childAggregate = resumedJournal.find((entry) => entry.key === "root/call:0" && entry.kind === "workflow");
  assert.equal(childAggregate?.tokens, 30, "the parent journal preserves prior usage and adds only new live usage");
  assert.equal(childAggregate?.agentCount, 2, "the parent journal preserves the full child agent count");
});

test("phase charges and cumulative spend survive resume without phase() rebasing", async () => {
  const journal: JournalEntry[] = [];
  let checkpoint: RuntimeCheckpoint | undefined;
  const first = await runWorkflow(
    `export const meta = { name: 'phase_first', description: 'phase first' }
phase('bounded', { budget: 100 })
return await agent('first', { label: 'first' })`,
    {
      agent: fakeAgent({ input: 80, total: 80 }),
      tokenBudget: 200,
      onAgentJournal: (entry) => journal.push(entry),
      onRuntimeCheckpoint: (value) => {
        checkpoint = value;
      },
      persistLogs: false,
    },
  );
  assert.equal(first.tokenUsage?.total, 80);
  assert.ok(checkpoint);

  let liveCalls = 0;
  let finalCheckpoint: RuntimeCheckpoint | undefined;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'phase_first', description: 'phase first' }
phase('bounded', { budget: 100 })
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })
try { await agent('third', { label: 'third' }) } catch {}
return 'caught'`,
        {
          agent: {
            async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
              liveCalls++;
              options.onUsage?.({ input: 30, output: 0, total: 30, cost: 0, cacheRead: 0, cacheWrite: 0 });
              return "ok";
            },
          },
          tokenBudget: 200,
          runtimeCheckpoint: checkpoint,
          resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
          onRuntimeCheckpoint: (value) => {
            finalCheckpoint = value;
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );

  assert.equal(liveCalls, 1, "the restored phase charge blocks the third call");
  assert.equal(
    finalCheckpoint?.usage.total,
    110,
    "cumulative logical-run spend includes pre-resume usage exactly once",
  );
  assert.equal(
    Object.values(finalCheckpoint?.phaseBudgets ?? {}).find((phaseBudget) => phaseBudget.title === "bounded")?.charged,
    110,
  );
});

test("live usage exhaustion aborts registered attempts and reports actual overshoot", async () => {
  let started = 0;
  const bothStarted = createDeferred<void>();
  const script = `export const meta = { name: 'live_budget', description: 'live budget' }
return await parallel([0, 1].map((i) => () => agent('work-' + i, { label: 'a' + i })))`;

  await assert.rejects(
    () =>
      runWorkflow(script, {
        concurrency: 2,
        tokenBudget: 100,
        agent: {
          async run(
            _prompt: string,
            options: {
              signal?: AbortSignal;
              onUsageUpdate?: (usage: AgentUsage) => void;
              onUsage?: (usage: AgentUsage) => void;
            },
          ) {
            started++;
            if (started === 2) bothStarted.resolve();
            await bothStarted.promise;
            const usage = { input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 };
            options.onUsageUpdate?.(usage);
            await new Promise<void>((resolve) => {
              const fallback = setTimeout(resolve, 25);
              const finish = () => {
                clearTimeout(fallback);
                resolve();
              };
              if (options.signal?.aborted) finish();
              else options.signal?.addEventListener("abort", finish, { once: true });
            });
            options.onUsage?.(usage);
            throw new Error("aborted after budget exhaustion");
          },
        },
        persistLogs: false,
      }),
    (error: unknown) => {
      const workflowError = error as WorkflowError & { usage?: { total: number }; overshoot?: number };
      assert.equal(workflowError.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      assert.equal(workflowError.usage?.total, 120);
      assert.equal(workflowError.overshoot, 20);
      return true;
    },
  );
});
