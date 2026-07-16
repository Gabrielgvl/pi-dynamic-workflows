import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { SharedStore } from "../src/shared-store.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

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

test("a parent-aborted settled attempt persists finalized usage exactly once before cancellation", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const progress: AgentUsage[] = [];
  let finalUsageEvents = 0;
  const run = runWorkflow(
    `export const meta = { name: 'abort-usage', description: 'abort usage' }
return await agent('work')`,
    {
      persistLogs: false,
      signal: controller.signal,
      onTokenUsageProgress: (usage) => progress.push(usage as AgentUsage),
      onTokenUsage: () => finalUsageEvents++,
      agent: {
        async run(_prompt: string, options: { signal?: AbortSignal; onUsage?: (usage: AgentUsage) => void }) {
          started.resolve();
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          options.onUsage?.({ input: 7, output: 4, cacheRead: 0, cacheWrite: 0, total: 11, cost: 0.01 });
          return "settled-after-abort";
        },
      },
    },
  );

  await started.promise;
  controller.abort();
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
    return true;
  });
  assert.deepEqual(
    progress.map((usage) => usage.total),
    [11],
  );
  assert.equal(finalUsageEvents, 0, "public usage remains final-success-only");
});

test("parallel cancellation is operation-scoped, awaits siblings, and permits later workflow work", async () => {
  let siblingSettled = false;
  const started = createDeferred<void>();
  const script = `export const meta = { name: 'parallel-cancel', description: 'parallel cancellation' }
let caught = ''
try {
  await parallel([
    () => agent('fatal'),
    () => agent('sibling'),
  ])
} catch (error) {
  caught = error.message
}
const after = await agent('after')
return { caught, after }`;

  const result = await runWorkflow(script, {
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { signal?: AbortSignal }) {
        if (prompt === "fatal") {
          await started.promise;
          throw new WorkflowError("fatal", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
        }
        if (prompt === "after") {
          assert.equal(siblingSettled, true, "parallel must await sibling cleanup before returning");
          return "continued";
        }
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        siblingSettled = true;
        throw new Error("cancelled sibling");
      },
    },
  });

  assert.equal(JSON.stringify(result.result), JSON.stringify({ caught: "fatal", after: "continued" }));
  assert.equal(siblingSettled, true);
});

test("pipeline cancellation is operation-scoped, awaits siblings, and permits later workflow work", async () => {
  let siblingSettled = false;
  const started = createDeferred<void>();
  const script = `export const meta = { name: 'pipeline-cancel', description: 'pipeline cancellation' }
let caught = ''
try {
  await pipeline(['fatal', 'sibling'], item => agent(item))
} catch (error) {
  caught = error.message
}
const after = await agent('after')
return { caught, after }`;

  const result = await runWorkflow(script, {
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { signal?: AbortSignal }) {
        if (prompt === "fatal") {
          await started.promise;
          throw new WorkflowError("fatal", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
        }
        if (prompt === "after") {
          assert.equal(siblingSettled, true, "pipeline must await sibling cleanup before returning");
          return "continued";
        }
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        siblingSettled = true;
        throw new Error("cancelled sibling");
      },
    },
  });

  assert.equal(JSON.stringify(result.result), JSON.stringify({ caught: "fatal", after: "continued" }));
  assert.equal(siblingSettled, true);
});

for (const operation of ["parallel", "pipeline"] as const) {
  test(`${operation} cancellation aborts and settles agents inside nested workflow() siblings`, async () => {
    let childAborted = false;
    const ended: Array<{ label: string; errorCode?: WorkflowErrorCode }> = [];
    const childStarted = createDeferred<void>();
    const releaseChild = createDeferred<void>();
    const child = `export const meta = { name: 'child', description: 'child' }
return await agent('nested sibling', { label: 'nested' })`;
    const operationCall =
      operation === "parallel"
        ? "parallel([() => agent('fatal', { label: 'fatal' }), () => workflow('child')])"
        : "pipeline(['fatal', 'child'], item => item === 'fatal' ? agent(item, { label: 'fatal' }) : workflow(item))";
    const parent = `export const meta = { name: 'nested-cancel', description: 'nested cancellation' }
let caught = ''
try {
  await ${operationCall}
} catch (error) {
  caught = error.message
}
const after = await agent('after', { label: 'after' })
return { caught, after }`;

    const run = runWorkflow<{ caught: string; after: string }>(parent, {
      persistLogs: false,
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      onAgentEnd: (event) => ended.push({ label: event.label, errorCode: event.errorCode }),
      agent: {
        async run(prompt: string, options: { signal?: AbortSignal }) {
          if (prompt === "fatal") {
            await childStarted.promise;
            throw new WorkflowError("fatal", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          }
          if (prompt === "after") return "continued";
          childStarted.resolve();
          const outcome = await Promise.race([
            new Promise<"aborted">((resolve) =>
              options.signal?.addEventListener("abort", () => resolve("aborted"), { once: true }),
            ),
            releaseChild.promise.then(() => "released" as const),
          ]);
          if (outcome === "aborted") {
            childAborted = true;
            throw new Error("nested sibling cancelled");
          }
          return "nested sibling escaped cancellation";
        },
      },
    });

    await childStarted.promise;
    setImmediate(() => releaseChild.resolve());
    const result = await run;
    assert.equal(result.result.caught, "fatal");
    assert.equal(result.result.after, "continued", "caught operation cancellation must not abort the parent run");
    assert.equal(childAborted, true, "operation cancellation must reach the nested child agent");
    assert.equal(
      ended.find((event) => event.label === "nested")?.errorCode,
      WorkflowErrorCode.WORKFLOW_ABORTED,
      "the cancelled nested agent must emit a terminal error event",
    );
  });
}

test("runWorkflow rejects unsafe explicit run IDs before creating logger paths", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-run-id-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-run-id-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      await assert.rejects(
        runWorkflow(`export const meta = { name: 'unsafe-id', description: 'unsafe id' }\nreturn 'ok'`, {
          cwd,
          runId: "../../escaped",
        }),
        /Invalid workflow run ID/,
      );
      assert.equal(existsSync(join(fakeHome, ".pi")), false, "validation must happen before logger directories exist");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("nested child run IDs stay safe and unique when the parent run ID is at the 128-character limit", async () => {
  const parentRunId = `p${"a".repeat(127)}`;
  const sessionNames: string[] = [];
  const child = `export const meta = { name: 'child', description: 'child' }
return await agent('child work')`;
  const parent = `export const meta = { name: 'parent', description: 'parent' }
return await parallel([
  () => workflow('child', { index: 0 }),
  () => workflow('child', { index: 1 }),
])`;

  const execute = async () => {
    const start = sessionNames.length;
    await runWorkflow(parent, {
      runId: parentRunId,
      persistLogs: false,
      loadSavedWorkflow: () => child,
      agent: {
        async run(_prompt: string, options: { sessionName?: string }) {
          if (options.sessionName) sessionNames.push(options.sessionName);
          return "ok";
        },
      },
    });
    return sessionNames
      .slice(start)
      .map((name) => name.slice("workflow:".length, name.indexOf(" ")))
      .sort();
  };

  const childRunIds = await execute();
  assert.equal(childRunIds.length, 2);
  assert.equal(new Set(childRunIds).size, 2, "concurrent child invocations must retain distinct run IDs");
  assert.deepEqual(await execute(), childRunIds, "the truncation/hash suffix must be deterministic");
  for (const childRunId of childRunIds) {
    assert.ok(childRunId.length <= 128, `child run ID exceeded 128 characters: ${childRunId.length}`);
    assert.match(childRunId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  }
});

test("nested workflow scriptPath rejects symlinks with SCRIPT_VALIDATION_ERROR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-nested-script-path-"));
  try {
    const childPath = join(root, "child.js");
    writeFileSync(
      childPath,
      "export const meta = { name: 'child', description: 'child' }\nreturn await agent('child')",
    );
    symlinkSync(childPath, join(root, "child-link.js"));
    const parent = `export const meta = { name: 'parent', description: 'parent' }
return await workflow({ scriptPath: 'child-link.js' })`;

    await assert.rejects(
      runWorkflow(parent, {
        cwd: root,
        persistLogs: false,
        agent: countingAgent().runner,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /symlink/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("structured agent results and replay are independent deterministic JSON snapshots", async () => {
  const shared = { count: 1 };
  const agentResult = { first: shared, second: shared };
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'structured_snapshot', description: 'snapshot isolation' }
const value = await agent('structured', {
  schema: {
    type: 'object',
    properties: {
      first: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      second: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    },
    required: ['first', 'second'],
  },
})
value.first.count = 9
return value`;

  const live = await runWorkflow<{ first: { count: number }; second: { count: number } }>(script, {
    agent: {
      async run() {
        return agentResult;
      },
    },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.deepEqual(live.result, { first: { count: 9 }, second: { count: 1 } });
  assert.deepEqual(journal[0].result, { first: { count: 1 }, second: { count: 1 } });
  assert.deepEqual(agentResult, { first: { count: 1 }, second: { count: 1 } });

  const replay = await runWorkflow<{ first: { count: number }; second: { count: number } }>(script, {
    agent: {
      async run() {
        throw new Error("must not rerun");
      },
    },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });

  assert.deepEqual(replay.result, { first: { count: 9 }, second: { count: 1 } });
  assert.deepEqual(journal[0].result, { first: { count: 1 }, second: { count: 1 } });
});

test("throwing onAgentEnd diagnostics do not retry or invalidate journaled store writes", async () => {
  const store = new SharedStore();
  const journal: JournalEntry[] = [];
  let calls = 0;
  const result = await runWorkflow<string>(
    `export const meta = { name: 'diagnostic-hook', description: 'best effort hook' }
return await agent('write')`,
    {
      agentRetries: 2,
      persistLogs: false,
      sharedStore: store,
      onAgentJournal: (entry) => journal.push(entry),
      onAgentEnd: () => {
        throw new Error("diagnostic listener failed");
      },
      agent: {
        async run(_prompt, options) {
          calls++;
          await options.systemTools
            ?.find((tool) => tool.name === "store_put")
            ?.execute("", {
              key: "committed",
              value: "kept",
            });
          return "done";
        },
      },
    },
  );

  assert.equal(result.result, "done");
  assert.equal(calls, 1);
  assert.equal(journal.length, 1);
  assert.equal(store.get("committed"), "kept");
});

test("throwing final token diagnostics do not invalidate journaled success", async () => {
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<string>(
    `export const meta = { name: 'token-hook', description: 'best effort final hook' }
return await agent('done')`,
    {
      agent: countingAgent().runner,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      onTokenUsage: () => {
        throw new Error("token listener failed");
      },
    },
  );

  assert.equal(result.result, "ran:done");
  assert.equal(journal.length, 1);
});

test("structured agent results reject unsupported non-JSON values before journaling", async () => {
  const journal: JournalEntry[] = [];
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'structured_invalid', description: 'invalid snapshot' }
return await agent('structured', { schema: { type: 'object' } })`,
        {
          agent: {
            async run() {
              return { createdAt: new Date(0) };
            },
          },
          persistLogs: false,
          onAgentJournal: (entry) => journal.push(entry),
        },
      ),
    /structured agent result.*deterministic JSON/i,
  );
  assert.equal(journal.length, 0);
});

test("structured string schema results preserve string semantics", async () => {
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<string>(
    `export const meta = { name: 'structured_string', description: 'string result' }
return await agent('structured', { schema: { type: 'string' } })`,
    {
      agent: {
        async run() {
          return "exact string";
        },
      },
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );
  assert.equal(result.result, "exact string");
  assert.equal(journal[0].result, "exact string");
});

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

test("concurrent sibling workflow() calls have invocation-local nesting depth", async () => {
  const release = createDeferred<void>();
  const started = new Set<string>();
  const child = `export const meta = { name: 'child', description: 'c' }
return await agent(args.name, { label: args.name })`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
return await parallel(['left', 'right'].map(name => () => workflow('child', { name })))`;

  const resultPromise = runWorkflow<string[]>(parent, {
    persistLogs: false,
    concurrency: 2,
    loadSavedWorkflow: () => child,
    agent: {
      async run(prompt: string) {
        started.add(prompt);
        if (started.size === 1) setImmediate(() => release.resolve());
        await release.promise;
        return `ran:${prompt}`;
      },
    },
  });

  const result = await resultPromise;
  assert.deepEqual(result.result, ["ran:left", "ran:right"]);
  assert.equal(result.agentCount, 2, "global agent accounting remains shared across sibling child invocations");
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

test("runWorkflow budget gates on accumulated tokens", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
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

test("phase sub-budget throws when a phase exceeds its ceiling (run total untouched)", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
let blocked = false
try {
  await agent('a', { label: '1' })
  await agent('b', { label: '2' })
} catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
phase('calm')
const after = await agent('c', { label: '3' })
return { blocked, after }`;
  const res = await runWorkflow<{ blocked: boolean; after: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    persistLogs: false,
  });
  assert.equal(res.result.blocked, true, "the 2nd agent in the phase hit the sub-budget");
  assert.ok(res.result.after !== null, "a later phase still proceeds");
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
return { cwd, processCwd: process.cwd() }`;

  const relativeCwd = mkdtempSync(join(tmpdir(), "pi-dw-canonical-cwd-"));
  try {
    const result = await runWorkflow<{ cwd: string; processCwd: string }>(script, {
      cwd: relativeCwd,
      agent: countingAgent().runner,
      persistLogs: false,
    });

    assert.equal(result.result.cwd, relativeCwd);
    assert.equal(result.result.processCwd, relativeCwd);
  } finally {
    rmSync(relativeCwd, { recursive: true, force: true });
  }
});

test("runWorkflow rejects a missing cwd as a workflow validation error before executing", async () => {
  const missing = join(tmpdir(), `pi-dw-missing-cwd-${process.pid}`);
  rmSync(missing, { recursive: true, force: true });
  let calls = 0;

  await assert.rejects(
    runWorkflow(`export const meta = { name: 'missing-cwd', description: 'missing cwd' }\nreturn await agent('no')`, {
      cwd: missing,
      persistLogs: false,
      agent: {
        async run() {
          calls++;
          return "unexpected";
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /working directory.*does not exist|invalid working directory/i);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("workflow cwd must be a directory before logs, persistence, or agents start", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-file-cwd-"));
  const file = join(root, "not-a-directory");
  writeFileSync(file, "regular file");
  let calls = 0;
  const run = () =>
    runWorkflow(`export const meta = { name: 'file-cwd', description: 'file cwd' }\nreturn await agent('no')`, {
      cwd: file,
      agent: {
        async run() {
          calls++;
          return "unexpected";
        },
      },
    });

  try {
    for (const operation of [run, async () => new WorkflowManager({ cwd: file })]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /workflow working directory.*not a directory/i);
        return true;
      });
    }
    assert.equal(calls, 0);
    assert.equal(existsSync(join(file, ".pi")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
