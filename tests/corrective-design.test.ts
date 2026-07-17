import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { SharedStore } from "../src/shared-store.js";
import { createTokenUsage, type RuntimeCheckpoint } from "../src/usage.js";
import { type JournalEntry, runWorkflow, type SharedRuntime } from "../src/workflow.js";

const usage = (total: number): AgentUsage => ({
  input: total,
  output: 0,
  total,
  cost: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const expectCode = (code: WorkflowErrorCode) => (error: unknown) => {
  assert.ok(error instanceof WorkflowError);
  assert.equal(error.code, code);
  return true;
};

const oneAgentChild = `export const meta = { name: 'child', description: 'child' }
phase('Shared', { budget: 1000 })
return await agent('child work')`;

const parentFor = (calls: string) => `export const meta = { name: 'parent', description: 'parent' }
${calls}`;

test("a lone final-only run budget crossing is terminal", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'run_final', description: 'run final' }
return await agent('work')`,
        {
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(usage(120));
              return "ok";
            },
          },
        },
      ),
    expectCode(WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED),
  );
});

test("a lone final-only phase budget crossing is terminal", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'phase_final', description: 'phase final' }
phase('Limited', { budget: 100 })
return await agent('work')`,
        {
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(usage(120));
              return "ok";
            },
          },
        },
      ),
    expectCode(WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED),
  );
});

test("catching an exhausted agent cannot make the logical run succeed", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'caught_budget', description: 'caught budget' }
let caught = false
try { await agent('work') } catch { caught = true }
return { caught }`,
        {
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(usage(120));
              return "ok";
            },
          },
        },
      ),
    expectCode(WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED),
  );
});

test("explicit parent abort takes precedence over simultaneous budget exhaustion", async () => {
  const controller = new AbortController();
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'abort_precedence', description: 'abort precedence' }
return await agent('work')`,
        {
          signal: controller.signal,
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(usage(120));
              controller.abort("explicit parent abort");
              return "ok";
            },
          },
        },
      ),
    expectCode(WorkflowErrorCode.WORKFLOW_ABORTED),
  );
});

test("a settled recoverable timeout does not mask terminal budget exhaustion", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'timeout_precedence', description: 'timeout precedence' }
return await agent('work')`,
        {
          tokenBudget: 100,
          agentTimeoutMs: 1,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
              options.onUsage?.(usage(120));
              return "late";
            },
          },
        },
      ),
    expectCode(WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED),
  );
});

test("run budget precedes phase budget and provider failure", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'budget_precedence', description: 'budget precedence' }
phase('Limited', { budget: 100 })
return await agent('work')`,
        {
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(usage(120));
              throw new Error("provider failed after telemetry");
            },
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      assert.match(error.message, /workflow token budget/i);
      return true;
    },
  );
});

test("a caught nested timeout remains recoverable while terminal budget exhaustion is reported", async () => {
  const child = `export const meta = { name: 'timeout_child', description: 'timeout child' }
return await agent('work')`;
  await assert.rejects(
    () =>
      runWorkflow(
        parentFor(`try { await workflow('child', {}, { key: 'timed' }) } catch {}
return 'caught'`),
        {
          loadSavedWorkflow: () => child,
          tokenBudget: 100,
          agentTimeoutMs: 1,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
              options.onUsage?.(usage(120));
              return "late";
            },
          },
        },
      ),
    expectCode(WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED),
  );
});

test("keyed identical siblings retain accounting identity across reorder and insertion", async () => {
  let nextTotals = [10, 20];
  const first = await runWorkflow(
    parentFor(`await workflow('child', { same: true }, { key: 'left' })
await workflow('child', { same: true }, { key: 'right' })
return 'first'`),
    {
      loadSavedWorkflow: () => oneAgentChild,
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
          options.onUsage?.(usage(nextTotals.shift() ?? 0));
          return "ok";
        },
      },
    },
  );
  const initial = Object.entries(first.runtimeCheckpoint.phaseBudgets);
  const leftScope = initial.find(([, state]) => state.charged === 10)?.[0];
  const rightScope = initial.find(([, state]) => state.charged === 20)?.[0];
  assert.ok(leftScope && rightScope);

  nextTotals = [2, 3, 4];
  const reordered = await runWorkflow(
    parentFor(`await workflow('child', { same: true }, { key: 'right' })
await workflow('child', { same: true }, { key: 'inserted' })
await workflow('child', { same: true }, { key: 'left' })
return 'second'`),
    {
      loadSavedWorkflow: () => oneAgentChild,
      runtimeCheckpoint: first.runtimeCheckpoint,
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
          options.onUsage?.(usage(nextTotals.shift() ?? 0));
          return "ok";
        },
      },
    },
  );

  assert.equal(reordered.runtimeCheckpoint.phaseBudgets[leftScope].charged, 14);
  assert.equal(reordered.runtimeCheckpoint.phaseBudgets[rightScope].charged, 22);
  assert.deepEqual(
    Object.values(reordered.runtimeCheckpoint.phaseBudgets)
      .map((state) => state.charged)
      .sort((a, b) => a - b),
    [3, 14, 22],
  );
});

test("a duplicate implicit nested identity is rejected with an actionable error", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        parentFor(`await workflow('child', { same: true })
return await workflow('child', { same: true })`),
        {
          loadSavedWorkflow: () => oneAgentChild,
          persistLogs: false,
          agent: {
            async run() {
              return "ok";
            },
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /duplicate.*implicit|provide.*key/i);
      return true;
    },
  );
});

test("duplicate normalized explicit nested keys are rejected", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        parentFor(`await workflow('child', {}, { key: ' sibling ' })
return await workflow('child', {}, { key: 'sibling' })`),
        {
          loadSavedWorkflow: () => oneAgentChild,
          persistLogs: false,
          agent: {
            async run() {
              return "ok";
            },
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /duplicate.*key/i);
      return true;
    },
  );
});

test("an empty explicit nested key is rejected", async () => {
  await assert.rejects(
    () =>
      runWorkflow(parentFor("return await workflow('child', {}, { key: '   ' })"), {
        loadSavedWorkflow: () => oneAgentChild,
        persistLogs: false,
        agent: {
          async run() {
            return "ok";
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /key.*non-empty|non-empty.*key/i);
      return true;
    },
  );
});

test("adding an explicit key never adopts an ambiguous legacy implicit occurrence", async () => {
  const implicitIdentity = createHash("sha256")
    .update(JSON.stringify({ workflowIdentity: { savedWorkflow: "child" }, args: { same: true } }))
    .digest("hex");
  const old0 = `root/workflow:${implicitIdentity}/occurrence:0/phase:Shared`;
  const old1 = `root/workflow:${implicitIdentity}/occurrence:1/phase:Shared`;
  const checkpoint = {
    schemaVersion: 1 as const,
    usage: createTokenUsage(),
    phaseBudgets: {
      [old0]: { title: "Shared", budget: 1000, charged: 10, warned: false },
      [old1]: { title: "Shared", budget: 1000, charged: 20, warned: false },
    },
    attempts: {},
  };

  const result = await runWorkflow(parentFor("return await workflow('child', { same: true }, { key: 'fresh' })"), {
    loadSavedWorkflow: () => oneAgentChild,
    runtimeCheckpoint: checkpoint,
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(usage(5));
        return "ok";
      },
    },
  });

  assert.equal(result.runtimeCheckpoint.phaseBudgets[old0].charged, 10);
  assert.equal(result.runtimeCheckpoint.phaseBudgets[old1].charged, 20);
  assert.ok(Object.values(result.runtimeCheckpoint.phaseBudgets).some((state) => state.charged === 5));
});

test("legacy display-only phase usage is not guessed into a keyed child", async () => {
  const checkpoint = {
    schemaVersion: 1 as const,
    usage: createTokenUsage(),
    phaseBudgets: {
      Shared: { budget: 1000, charged: 30, warned: false },
    },
    attempts: {},
  };
  const result = await runWorkflow(parentFor("return await workflow('child', {}, { key: 'fresh' })"), {
    loadSavedWorkflow: () => oneAgentChild,
    runtimeCheckpoint: checkpoint,
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(usage(5));
        return "ok";
      },
    },
  });

  assert.equal(result.runtimeCheckpoint.phaseBudgets.Shared.charged, 30);
  assert.ok(Object.values(result.runtimeCheckpoint.phaseBudgets).some((state) => state.charged === 5));
});

test("prior-generation failed and successful attempts are charged once to one stable wrapper scope", async () => {
  const child = `export const meta = { name: 'generation_child', description: 'generation child' }
return await agent('same call')`;
  const parent = parentFor("return await workflow('child', {}, { key: 'stable' })");
  let checkpoint: RuntimeCheckpoint | undefined;

  await assert.rejects(() =>
    runWorkflow(parent, {
      loadSavedWorkflow: () => child,
      persistLogs: false,
      onRuntimeCheckpoint: (value) => {
        checkpoint = value;
      },
      agent: {
        async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
          options.onUsage?.(usage(7));
          throw new WorkflowError("first generation failed", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        },
      },
    }),
  );
  assert.ok(checkpoint);

  const journal: JournalEntry[] = [];
  const resumed = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    runtimeCheckpoint: checkpoint,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(usage(5));
        return "ok";
      },
    },
  });
  const wrapper = journal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");

  assert.equal(resumed.tokenUsage?.total, 12);
  assert.equal(wrapper?.tokens, 12);
  assert.equal(wrapper?.usage?.total, 12);
});

test("whole-wrapper replay reports cached usage without adding physical or scope usage", async () => {
  const child = `export const meta = { name: 'whole_child', description: 'whole child' }
return await agent('work')`;
  const parent = parentFor("return await workflow('child', {}, { key: 'stable' })");
  const journal: JournalEntry[] = [];
  const first = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(usage(7));
        return "ok";
      },
    },
  });
  const firstScopes = structuredClone(
    (first.runtimeCheckpoint as unknown as { scopeUsage?: Record<string, { total: number }> }).scopeUsage,
  );

  let liveCalls = 0;
  const replayed = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    runtimeCheckpoint: first.runtimeCheckpoint,
    resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
    persistLogs: false,
    agent: {
      async run() {
        liveCalls++;
        return "unexpected";
      },
    },
  });

  assert.equal(liveCalls, 0);
  assert.equal(replayed.tokenUsage?.total, 7);
  assert.equal(replayed.tokenUsage?.accounting?.journalReplay, 7);
  assert.deepEqual(
    (replayed.runtimeCheckpoint as unknown as { scopeUsage?: Record<string, { total: number }> }).scopeUsage,
    firstScopes,
  );
});

test("partial child replay plus live work adds only new deltas to the stable wrapper aggregate", async () => {
  const initialChild = `export const meta = { name: 'partial_child', description: 'partial child' }
await agent('first')
return await agent('second')`;
  const updatedChild = `export const meta = { name: 'partial_child', description: 'partial child updated' }
await agent('first')
return await agent('second changed')`;
  const parent = parentFor("return await workflow('child', {}, { key: 'stable' })");
  const journal: JournalEntry[] = [];
  const totals = [3, 4];
  const first = await runWorkflow(parent, {
    loadSavedWorkflow: () => initialChild,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(usage(totals.shift() ?? 0));
        return "ok";
      },
    },
  });

  const resumedJournal: JournalEntry[] = [];
  let liveCalls = 0;
  const partial = await runWorkflow(parent, {
    loadSavedWorkflow: () => updatedChild,
    runtimeCheckpoint: first.runtimeCheckpoint,
    resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
    onAgentJournal: (entry) => resumedJournal.push(entry),
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        liveCalls++;
        options.onUsage?.(usage(5));
        return "new";
      },
    },
  });
  const wrapper = resumedJournal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");

  assert.equal(liveCalls, 1);
  assert.equal(partial.tokenUsage?.total, 12);
  assert.equal(partial.tokenUsage?.accounting?.journalReplay, 3);
  assert.equal(wrapper?.tokens, 12);
});

test("schema-1 unattributable usage remains global and is not guessed into a keyed child scope", async () => {
  const legacyUsage = createTokenUsage();
  legacyUsage.input = 50;
  legacyUsage.total = 50;
  legacyUsage.accounting.legacyUnclassified = 50;
  const checkpoint = {
    schemaVersion: 1 as const,
    usage: legacyUsage,
    phaseBudgets: {},
    attempts: {},
  };
  const journal: JournalEntry[] = [];

  const result = await runWorkflow(parentFor("return await workflow('child', {}, { key: 'new' })"), {
    loadSavedWorkflow: () => oneAgentChild,
    runtimeCheckpoint: checkpoint,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(usage(5));
        return "ok";
      },
    },
  });
  const wrapper = journal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");

  assert.equal(result.tokenUsage?.total, 55);
  assert.equal(wrapper?.tokens, 5);
});

test("wrapper store delta follows final live write order and replays a successful overwrite", async () => {
  const child = `export const meta = { name: 'store_child', description: 'store child' }
try { await agent('failed old') } catch {}
return await agent('successful new')`;
  const parent = parentFor(`await workflow('child', {}, { key: 'store' })
return await agent('read final')`);
  const journal: JournalEntry[] = [];
  const store = new SharedStore();
  const runner = {
    async run(
      prompt: string,
      options: {
        systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
      },
    ) {
      const put = options.systemTools?.find((tool) => tool.name === "store_put");
      const get = options.systemTools?.find((tool) => tool.name === "store_get");
      if (prompt === "failed old") {
        await put?.execute("", { key: "value", value: "old" });
        throw new WorkflowError("failed after write", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      }
      if (prompt === "successful new") {
        await put?.execute("", { key: "value", value: "new" });
        return "wrote new";
      }
      const response = (await get?.execute("", { key: "value" })) as { details?: { value?: unknown } };
      return response.details?.value;
    },
  };

  const first = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    sharedStore: store,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: runner,
  });
  const wrapper = journal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");
  assert.equal(first.result, "new");
  assert.deepEqual(wrapper?.storeDelta, { value: "new" });

  store.restore({});
  const replayed = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    sharedStore: store,
    resumeJournal: new Map([["root/call:0", wrapper as JournalEntry]]),
    persistLogs: false,
    agent: runner,
  });
  assert.equal(replayed.result, "new");
});

test("live-operation scope trackers are removed after release, including a reused SharedRuntime", async () => {
  const shared: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage: createTokenUsage(),
    depth: 0,
    liveInvocations: new Set(),
    liveOperationsByScope: new Map(),
  };
  const script = `export const meta = { name: 'cleanup', description: 'cleanup' }
return await agent('work')`;
  const options = {
    sharedRuntime: shared,
    persistLogs: false,
    agent: {
      async run(_prompt: string, runOptions: { onUsage?: (value: AgentUsage) => void }) {
        runOptions.onUsage?.(usage(1));
        return "ok";
      },
    },
  };

  await runWorkflow(script, options);
  assert.equal(shared.liveOperationsByScope?.size, 0);
  await runWorkflow(script, options);
  assert.equal(shared.liveOperationsByScope?.size, 0);
});
