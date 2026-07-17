import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { addUsageSample, createTokenUsage, type RuntimeCheckpoint } from "../src/usage.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const measured = (total: number): AgentUsage => ({
  input: total,
  output: 0,
  total,
  cost: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const journalMap = (journal: JournalEntry[]): Map<string | number, JournalEntry> =>
  new Map(journal.map((entry) => [entry.key ?? entry.index, entry]));

const parentScript = (body: string): string => `export const meta = { name: 'parent', description: 'parent' }\n${body}`;

test("a keyed child resumes descendant journals after failure before its wrapper checkpoint", async () => {
  const child = `export const meta = { name: 'partial', description: 'partial child' }
await agent('first', { label: 'first' })
return await agent('second', { label: 'second' })`;
  const parent = parentScript("return await workflow('child', {}, { key: 'stable' })");
  const journal: JournalEntry[] = [];
  let checkpoint: RuntimeCheckpoint | undefined;
  let firstCalls = 0;

  await assert.rejects(() =>
    runWorkflow(parent, {
      loadSavedWorkflow: () => child,
      onAgentJournal: (entry) => journal.push(entry),
      onRuntimeCheckpoint: (value) => {
        checkpoint = value;
      },
      persistLogs: false,
      agent: {
        async run(prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
          firstCalls++;
          options.onUsage?.(measured(prompt === "first" ? 3 : 4));
          if (prompt === "second") {
            throw new WorkflowError("second failed", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
              recoverable: false,
            });
          }
          return "first-result";
        },
      },
    }),
  );

  assert.equal(firstCalls, 2);
  assert.equal(
    journal.some((entry) => entry.kind === "workflow"),
    false,
    "failed child has no wrapper checkpoint",
  );
  assert.equal(journal.filter((entry) => entry.kind === "agent").length, 1);
  assert.ok(checkpoint);

  const resumedJournal: JournalEntry[] = [];
  const resumedPrompts: string[] = [];
  const resumed = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    resumeJournal: journalMap(journal),
    runtimeCheckpoint: checkpoint,
    onAgentJournal: (entry) => resumedJournal.push(entry),
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        resumedPrompts.push(prompt);
        options.onUsage?.(measured(5));
        return "second-result";
      },
    },
  });

  assert.deepEqual(resumedPrompts, ["second"], "the completed first child call replays by stable child scope");
  assert.equal(resumed.result, "second-result");
  assert.equal(
    resumed.tokenUsage?.total,
    12,
    "physical usage includes first success, failed second, and resumed second",
  );
  assert.equal(resumed.tokenUsage?.accounting?.journalReplay, 3);
  const wrapper = resumedJournal.find((entry) => entry.kind === "workflow");
  assert.equal(wrapper?.tokens, 12);
});

test("dynamically detected duplicate keys retain earlier child checkpoints without charge transfer", async () => {
  const child = `export const meta = { name: 'duplicate-child', description: 'duplicate child' }
phase('Child', { budget: 100 })
return await agent('first child work')`;
  const journal: JournalEntry[] = [];
  let checkpoint: RuntimeCheckpoint | undefined;
  await assert.rejects(
    () =>
      runWorkflow(
        parentScript(`await workflow('child', {}, { key: 'duplicate' })
return await workflow('child', {}, { key: 'duplicate' })`),
        {
          loadSavedWorkflow: () => child,
          onAgentJournal: (entry) => journal.push(entry),
          onRuntimeCheckpoint: (value) => {
            checkpoint = value;
          },
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(measured(6));
              return "checkpointed";
            },
          },
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );

  assert.equal(journal.filter((entry) => entry.kind === "agent").length, 1);
  assert.equal(journal.filter((entry) => entry.kind === "workflow").length, 1);
  const scoped = Object.values(checkpoint?.scopeUsage ?? {}).filter((value) => value.total > 0);
  assert.deepEqual(
    scoped.map((value) => value.total),
    [6],
  );
  const charged = Object.values(checkpoint?.phaseBudgets ?? {}).filter((value) => value.charged > 0);
  assert.deepEqual(
    charged.map((value) => value.charged),
    [6],
  );
});

test("reordering keyed siblings keeps descendant replay and prior attempt usage with the owning sibling", async () => {
  const child = `export const meta = { name: 'child', description: 'child' }
return await agent('same inner call', { label: 'inner' })`;
  const firstParent = parentScript(`const left = await workflow('child', {}, { key: 'left' })
const right = await workflow('child', {}, { key: 'right' })
return { left, right }`);
  const journal: JournalEntry[] = [];
  const totals = [3, 7];
  const first = await runWorkflow(firstParent, {
    loadSavedWorkflow: () => child,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(measured(totals.shift() ?? 0));
        return "ok";
      },
    },
  });

  const replayJournal: JournalEntry[] = [];
  let liveCalls = 0;
  const reordered = await runWorkflow(
    parentScript(`const right = await workflow('child', {}, { key: 'right' })
const left = await workflow('child', {}, { key: 'left' })
return { left, right }`),
    {
      loadSavedWorkflow: () => child,
      resumeJournal: journalMap(journal),
      runtimeCheckpoint: first.runtimeCheckpoint,
      onAgentJournal: (entry) => replayJournal.push(entry),
      persistLogs: false,
      agent: {
        async run() {
          liveCalls++;
          return "unexpected";
        },
      },
    },
  );

  assert.equal(liveCalls, 0);
  assert.equal(reordered.tokenUsage?.total, 10);
  assert.equal(reordered.tokenUsage?.accounting?.journalReplay, 10);
  const wrappers = replayJournal.filter((entry) => entry.kind === "workflow");
  assert.equal(wrappers.length, 2);
  const byScope = new Map(wrappers.map((entry) => [entry.accountingScopeKey, entry.tokens]));
  const originalWrappers = journal.filter((entry) => entry.kind === "workflow");
  for (const entry of originalWrappers) {
    assert.equal(byScope.get(entry.accountingScopeKey), entry.tokens);
  }
});

test("completed keyed wrapper replay rebases store order for every reordered generation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-wrapper-store-rebase-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-wrapper-store-rebase-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const child = `export const meta = { name: 'winner-child', description: 'winner child' }
return await agent('write winner', { label: args.side })`;
      const parent = (first: "A" | "B", second: "A" | "B", readerGeneration: number): string =>
        parentScript(`await workflow('child', { side: '${first}' }, { key: '${first}' })
await workflow('child', { side: '${second}' }, { key: '${second}' })
return await agent('read winner generation ${readerGeneration}', { label: 'reader' })`);
      const childCalls = new Map<string, number>();
      const createRunner = (trackChildCalls: boolean) => ({
        async run(
          prompt: string,
          options: {
            label?: string;
            systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
          },
        ) {
          const put = options.systemTools?.find((tool) => tool.name === "store_put");
          const get = options.systemTools?.find((tool) => tool.name === "store_get");
          if (prompt === "write winner") {
            const side = options.label ?? "unknown";
            if (trackChildCalls) childCalls.set(side, (childCalls.get(side) ?? 0) + 1);
            await put?.execute("", { key: "winner", value: side });
            return side;
          }
          const response = (await get?.execute("", { key: "winner" })) as { details?: { value?: unknown } };
          return response.details?.value;
        },
      });
      const manager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: createRunner(true),
      });

      const first = await manager.runSync(parent("A", "B", 1));
      assert.equal(first.result, "B");
      const runId = manager.listRuns()[0].runId;

      const resumeWith = async (script: string): Promise<unknown> => {
        const persisted = manager.getPersistence().load(runId);
        assert.ok(persisted);
        manager.getPersistence().save({
          ...persisted,
          script,
          status: "paused",
          result: undefined,
          completedAt: undefined,
        });
        const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
        assert.equal(await manager.resume(runId), true);
        await completed;
        return manager.getRun(runId)?.result?.result;
      };

      const secondScript = parent("B", "A", 2);
      const second = await resumeWith(secondScript);
      const freshSecond = await runWorkflow(secondScript, {
        loadSavedWorkflow: () => child,
        persistLogs: false,
        agent: createRunner(false),
      });
      assert.equal(freshSecond.result, "A");
      assert.equal(second, freshSecond.result, "replayed wrappers follow the current generation's B then A order");

      const thirdScript = parent("A", "B", 3);
      const third = await resumeWith(thirdScript);
      const freshThird = await runWorkflow(thirdScript, {
        loadSavedWorkflow: () => child,
        persistLogs: false,
        agent: createRunner(false),
      });
      assert.equal(freshThird.result, "B");
      assert.equal(third, freshThird.result, "a third generation rebase follows the new A then B order");
      assert.deepEqual(Object.fromEntries(childCalls), { A: 1, B: 1 }, "completed children never rerun live");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("partial child replay restores original parallel store write order", async () => {
  const childV1 = `export const meta = { name: 'store-child', description: 'v1' }
await Promise.all([agent('late lexical first'), agent('early lexical second')])
return 'done'`;
  const childV2 = childV1.replace("description: 'v1'", "description: 'v2'");
  const parent = parentScript(`await workflow('child', {}, { key: 'store' })
return await agent('read winner')`);
  const journal: JournalEntry[] = [];
  let releaseLate!: () => void;
  const earlyWritten = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const first = await runWorkflow(parent, {
    concurrency: 2,
    loadSavedWorkflow: () => childV1,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(
        prompt: string,
        options: {
          systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
        },
      ) {
        const put = options.systemTools?.find((tool) => tool.name === "store_put");
        const get = options.systemTools?.find((tool) => tool.name === "store_get");
        if (prompt === "early lexical second") {
          await put?.execute("", { key: "winner", value: "early" });
          releaseLate();
          return "early";
        }
        if (prompt === "late lexical first") {
          await earlyWritten;
          await put?.execute("", { key: "winner", value: "late" });
          return "late";
        }
        const response = (await get?.execute("", { key: "winner" })) as { details?: { value?: unknown } };
        return response.details?.value;
      },
    },
  });
  assert.equal(first.result, "late");

  const resumedPrompts: string[] = [];
  const resumed = await runWorkflow(parent, {
    concurrency: 2,
    loadSavedWorkflow: () => childV2,
    resumeJournal: journalMap(journal),
    runtimeCheckpoint: first.runtimeCheckpoint,
    persistLogs: false,
    agent: {
      async run(
        prompt: string,
        options: {
          systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
        },
      ) {
        resumedPrompts.push(prompt);
        assert.equal(prompt, "read winner", "both child agents must replay");
        const get = options.systemTools?.find((tool) => tool.name === "store_get");
        const response = (await get?.execute("", { key: "winner" })) as { details?: { value?: unknown } };
        return response.details?.value;
      },
    },
  });

  assert.deepEqual(resumedPrompts, ["read winner"]);
  assert.equal(resumed.result, "late", "replay reconstructs the same final value as live write order");
});

interface NestedCollisionCase {
  name: string;
  firstCall: string;
  secondCall: string;
}

const keyedCall = (args: string): string => `workflow('child', ${args}, { key: 'stable' })`;
const collisionCases: NestedCollisionCase[] = [
  {
    name: "omitted and explicit undefined",
    firstCall: "workflow('child')",
    secondCall: "workflow('child', undefined)",
  },
  { name: "undefined and null", firstCall: keyedCall("undefined"), secondCall: keyedCall("null") },
  {
    name: "nested undefined and an ordinary marker object",
    firstCall: keyedCall("{ value: undefined }"),
    secondCall: keyedCall("{ value: { $undefined: true } }"),
  },
  { name: "NaN and its string spelling", firstCall: keyedCall("NaN"), secondCall: keyedCall("'NaN'") },
  {
    name: "positive infinity and its string spelling",
    firstCall: keyedCall("Infinity"),
    secondCall: keyedCall("'Infinity'"),
  },
  {
    name: "negative infinity and its string spelling",
    firstCall: keyedCall("-Infinity"),
    secondCall: keyedCall("'-Infinity'"),
  },
  { name: "negative zero and zero", firstCall: keyedCall("-0"), secondCall: keyedCall("0") },
  { name: "arrays and objects", firstCall: keyedCall("['x']"), secondCall: keyedCall("{ 0: 'x' }") },
];

for (const collision of collisionCases) {
  test(`nested identity distinguishes ${collision.name}`, async () => {
    const child = `export const meta = { name: 'identity-child', description: 'identity child' }\nreturn args`;
    const firstJournal: JournalEntry[] = [];
    await runWorkflow(parentScript(`return await ${collision.firstCall}`), {
      loadSavedWorkflow: () => child,
      onAgentJournal: (entry) => firstJournal.push(entry),
      persistLogs: false,
    });

    const secondJournal: JournalEntry[] = [];
    let replayed = 0;
    await runWorkflow(parentScript(`return await ${collision.secondCall}`), {
      loadSavedWorkflow: () => child,
      resumeJournal: journalMap(firstJournal),
      onAgentJournal: (entry) => secondJournal.push(entry),
      onJournalReplay: () => {
        replayed++;
      },
      persistLogs: false,
    });

    assert.equal(replayed, 0, "a colliding old wrapper must not replay");
    assert.equal(
      secondJournal.some((entry) => entry.kind === "workflow"),
      true,
    );
  });
}

test("nested identity canonicalization sorts object keys", async () => {
  const child = `export const meta = { name: 'sorted-child', description: 'sorted child' }\nreturn 'cached'`;
  const journal: JournalEntry[] = [];
  await runWorkflow(parentScript("return await workflow('child', { b: 2, a: 1 }, { key: 'stable' })"), {
    loadSavedWorkflow: () => child,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
  });

  let replayed = 0;
  const secondJournal: JournalEntry[] = [];
  const resumed = await runWorkflow(parentScript("return await workflow('child', { a: 1, b: 2 }, { key: 'stable' })"), {
    loadSavedWorkflow: () => child,
    resumeJournal: journalMap(journal),
    onJournalReplay: () => {
      replayed++;
    },
    onAgentJournal: (entry) => secondJournal.push(entry),
    persistLogs: false,
  });

  assert.equal(resumed.result, "cached");
  assert.equal(replayed, 1);
  assert.equal(secondJournal.length, 0);
});

for (const unsupported of [
  { name: "cyclic", setup: "const value = {}; value.self = value" },
  { name: "function", setup: "const value = () => true" },
  { name: "symbol", setup: "const value = Symbol('value')" },
  { name: "bigint", setup: "const value = 1n" },
]) {
  test(`nested identity rejects unsupported ${unsupported.name} arguments actionably`, async () => {
    const child = `export const meta = { name: 'unsupported-child', description: 'unsupported child' }\nreturn 'unexpected'`;
    await assert.rejects(
      () =>
        runWorkflow(parentScript(`${unsupported.setup}\nreturn await workflow('child', value, { key: 'stable' })`), {
          loadSavedWorkflow: () => child,
          persistLogs: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, new RegExp(`${unsupported.name}|unsupported|args`, "i"));
        return true;
      },
    );
  });
}

test("whole-wrapper manager replay preserves persisted child UI rows and runtime attempts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-wrapper-ui-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-wrapper-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const child = `export const meta = { name: 'ui-child', description: 'ui child', phases: [{ title: 'Child' }] }
return await agent('child work', { label: 'child row' })`;
      const parent = parentScript("return await workflow('child', {}, { key: 'stable' })");
      const firstManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run(
            _prompt: string,
            options: {
              onHistory?: (history: Array<{ role: string; kind: string; text: string }>) => void;
              onModelResolved?: (model: string) => void;
              onUsage?: (value: AgentUsage) => void;
            },
          ) {
            options.onModelResolved?.("provider/stable-model");
            options.onHistory?.([{ role: "assistant", kind: "text", text: "persisted history" }]);
            options.onUsage?.(measured(9));
            return "done";
          },
        },
      });
      await firstManager.runSync(parent);
      const firstPersisted = firstManager.listRuns()[0];
      assert.equal(firstPersisted.agents.length, 1);
      const firstAttempts = Object.values(firstPersisted.runtimeCheckpoint?.attempts ?? {}).flat();
      assert.equal(firstAttempts.length, 1);

      firstManager.getPersistence().save({
        ...firstPersisted,
        status: "paused",
        result: undefined,
        completedAt: undefined,
      });

      let liveCalls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run() {
            liveCalls++;
            throw new Error("whole wrapper replay must not run a child");
          },
        },
      });
      const completed = new Promise<void>((resolve) => resumedManager.once("complete", () => resolve()));
      assert.equal(await resumedManager.resume(firstPersisted.runId), true);
      await completed;

      const resumed = resumedManager.listRuns().find((run) => run.runId === firstPersisted.runId);
      assert.equal(liveCalls, 0);
      assert.equal(resumed?.agents.length, 1, "resume does not delete or duplicate the persisted child row");
      assert.equal(resumed?.agents[0].label, "child row");
      assert.equal(resumed?.agents[0].phase, "Child");
      assert.equal(resumed?.agents[0].model, "provider/stable-model");
      assert.equal(resumed?.agents[0].tokens, 9);
      assert.equal(resumed?.agents[0].history?.[0]?.text, "persisted history");
      assert.equal(resumed?.agents[0].status, "done");
      const resumedAttempts = Object.values(resumed?.runtimeCheckpoint?.attempts ?? {}).flat();
      assert.equal(resumedAttempts.length, 1, "wrapper replay does not create a physical attempt");
      assert.equal(resumed?.tokenUsage?.total, 9);
      assert.equal(
        resumed?.tokenUsage && "accounting" in resumed.tokenUsage
          ? resumed.tokenUsage.accounting.journalReplay
          : undefined,
        9,
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an exhausted timeout settles and remains a recoverable null", async () => {
  let settled = false;
  const result = await runWorkflow(
    `export const meta = { name: 'timeout-null', description: 'timeout null' }
return await agent('slow', { timeoutMs: 1 })`,
    {
      persistLogs: false,
      agent: {
        async run() {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          settled = true;
          return "late";
        },
      },
    },
  );

  assert.equal(settled, true);
  assert.equal(result.result, null);
});

test("an unrelated uncaught script error remains primary after final-only budget exhaustion", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'script-primary', description: 'script primary' }
await agent('work')
throw new Error('unrelated script failure')`,
        {
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(measured(120));
              return "done";
            },
          },
        },
      ),
    (error: unknown) => {
      const scriptError = error as { message?: string; code?: string };
      assert.match(scriptError.message ?? "", /unrelated script failure/);
      assert.equal(scriptError.code, undefined);
      return true;
    },
  );
});

test("final-only budget exhaustion stays terminal when the script catches an agent failure", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'caught-final-budget', description: 'caught final budget' }
try { await agent('work') } catch {}
return 'script recovered'`,
        {
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
              options.onUsage?.(measured(120));
              throw new Error("provider failed after final telemetry");
            },
          },
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );
});

test("journal replay chooses the newest matching stable identity, kind, and call hash", async () => {
  const script = `export const meta = { name: 'newest-journal', description: 'newest journal' }
return await agent('stable call', { label: 'stable' })`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "original";
      },
    },
  });
  const entry = journal[0];
  assert.ok(entry);

  let liveCalls = 0;
  const resumed = await runWorkflow(script, {
    persistLogs: false,
    resumeJournal: new Map<string | number, JournalEntry>([
      ["historical", { ...entry, result: "historical" }],
      ["wrong-kind", { ...entry, kind: "checkpoint", result: "wrong-kind" }],
      ["newest", { ...entry, result: "newest" }],
    ]),
    agent: {
      async run() {
        liveCalls++;
        return "live";
      },
    },
  });

  assert.equal(liveCalls, 0);
  assert.equal(resumed.result, "newest");
});

test("a stable journal identity never falls back to a positional sibling", async () => {
  const script = `export const meta = { name: 'stable-no-fallback', description: 'stable no fallback' }
return await agent('same hash', { label: 'expected' })`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "sibling-result";
      },
    },
  });
  const sibling = journal[0];
  assert.ok(sibling);

  let liveCalls = 0;
  const resumed = await runWorkflow(script, {
    persistLogs: false,
    resumeJournal: new Map([
      [
        sibling.key as string,
        {
          ...sibling,
          accountingScopeKey: "root/workflow-key:sibling",
          accountingCallKey: "root/workflow-key:sibling/call:0",
        },
      ],
    ]),
    agent: {
      async run() {
        liveCalls++;
        return "expected-live";
      },
    },
  });

  assert.equal(liveCalls, 1);
  assert.equal(resumed.result, "expected-live");
});

test("repeated keyed reorders retain sibling results and store deltas without duplicate child work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-repeated-reorder-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-repeated-reorder-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const child = `export const meta = { name: 'reorder-child', description: 'reorder child' }
return await agent('same child work', { label: args.side })`;
      const scripts = [
        parentScript(`const left = await workflow('child', { side: 'left' }, { key: 'left' })
const stored = await agent('read left-only store', { label: 'reader' })
return { left, stored }`),
        parentScript(`const right = await workflow('child', { side: 'right' }, { key: 'right' })
const left = await workflow('child', { side: 'left' }, { key: 'left' })
const stored = await agent('read right-left store', { label: 'reader' })
return { left, right, stored }`),
        parentScript(`const left = await workflow('child', { side: 'left' }, { key: 'left' })
const right = await workflow('child', { side: 'right' }, { key: 'right' })
const stored = await agent('read left-right store', { label: 'reader' })
return { left, right, stored }`),
      ];
      const childCalls = new Map<string, number>();
      const manager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run(
            prompt: string,
            options: {
              label?: string;
              systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
            },
          ) {
            const put = options.systemTools?.find((tool) => tool.name === "store_put");
            const get = options.systemTools?.find((tool) => tool.name === "store_get");
            if (prompt === "same child work") {
              const side = options.label ?? "unknown";
              childCalls.set(side, (childCalls.get(side) ?? 0) + 1);
              await put?.execute("", { key: "winner", value: `${side}-store` });
              return `${side}-result`;
            }
            const response = (await get?.execute("", { key: "winner" })) as { details?: { value?: unknown } };
            return response.details?.value;
          },
        },
      });

      const first = await manager.runSync(scripts[0]);
      assert.equal(JSON.stringify(first.result), JSON.stringify({ left: "left-result", stored: "left-store" }));
      const runId = manager.listRuns()[0].runId;

      const resumeWith = async (script: string): Promise<void> => {
        const persisted = manager.getPersistence().load(runId);
        assert.ok(persisted);
        manager.getPersistence().save({
          ...persisted,
          script,
          status: "paused",
          result: undefined,
          completedAt: undefined,
        });
        const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
        assert.equal(await manager.resume(runId), true);
        await completed;
      };

      await resumeWith(scripts[1]);
      assert.equal(
        JSON.stringify(manager.getRun(runId)?.result?.result),
        JSON.stringify({ left: "left-result", right: "right-result", stored: "left-store" }),
      );
      await resumeWith(scripts[2]);
      assert.equal(
        JSON.stringify(manager.getRun(runId)?.result?.result),
        JSON.stringify({ left: "left-result", right: "right-result", stored: "right-store" }),
      );
      assert.deepEqual(Object.fromEntries(childCalls), { left: 1, right: 1 });

      const persisted = manager.getPersistence().load(runId);
      const stableJournalIdentities = (persisted?.journal ?? []).map(
        (entry) => `${entry.kind}:${entry.accountingCallKey ?? entry.accountingScopeKey ?? entry.key}`,
      );
      assert.equal(new Set(stableJournalIdentities).size, stableJournalIdentities.length);
      assert.equal(
        persisted?.journal?.some(
          (entry) => entry.kind === "agent" && entry.accountingScopeKey?.includes("workflow-key:"),
        ),
        true,
        "partial-resume descendants remain persisted",
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

const invalidDataOnlyCases = [
  { name: "class instance", setup: "class Box { constructor() { this.value = 1 } }; const value = new Box()" },
  { name: "custom prototype", setup: "const value = Object.create({ inherited: true }); value.own = 1" },
  { name: "array custom property", setup: "const value = [1]; value.extra = true" },
  { name: "array symbol property", setup: "const value = [1]; value[Symbol('extra')] = true" },
  {
    name: "array non-enumerable property",
    setup: "const value = [1]; Object.defineProperty(value, 'hidden', { value: true })",
  },
  { name: "object symbol property", setup: "const value = { visible: 1 }; value[Symbol('extra')] = true" },
  {
    name: "object non-enumerable property",
    setup: "const value = { visible: 1 }; Object.defineProperty(value, 'hidden', { value: true })",
  },
];

for (const invalid of invalidDataOnlyCases) {
  test(`nested identity rejects ${invalid.name} as non-data input`, async () => {
    const child = `export const meta = { name: 'data-only-child', description: 'data only child' }\nreturn 'unexpected'`;
    await assert.rejects(
      () =>
        runWorkflow(parentScript(`${invalid.setup}\nreturn await workflow('child', value, { key: 'stable' })`), {
          loadSavedWorkflow: () => child,
          persistLogs: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /nested workflow args|data|property|prototype|array/i);
        return true;
      },
    );
  });
}

test("nested identity rejects accessors without executing their getters", async () => {
  const child = `export const meta = { name: 'getter-child', description: 'getter child' }\nreturn 'unexpected'`;
  await assert.rejects(
    () =>
      runWorkflow(
        parentScript(`const value = {}
Object.defineProperty(value, 'secret', { enumerable: true, get() { throw new Error('GETTER_EXECUTED') } })
return await workflow('child', value, { key: 'stable' })`),
        { loadSavedWorkflow: () => child, persistLogs: false },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.doesNotMatch(error.message, /GETTER_EXECUTED/);
      return true;
    },
  );
});

test("invalid hidden identity data cannot replay a stale plain wrapper", async () => {
  const child = `export const meta = { name: 'hidden-child', description: 'hidden child' }\nreturn 'cached'`;
  const journal: JournalEntry[] = [];
  await runWorkflow(parentScript("return await workflow('child', { visible: 1 }, { key: 'stable' })"), {
    loadSavedWorkflow: () => child,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
  });

  let replayed = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        parentScript(`const value = { visible: 1 }
Object.defineProperty(value, 'hidden', { value: 2 })
return await workflow('child', value, { key: 'stable' })`),
        {
          loadSavedWorkflow: () => child,
          resumeJournal: journalMap(journal),
          onJournalReplay: () => {
            replayed++;
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(replayed, 0);
});

test("schema-1 attempts from another keyed scope remain global and do not seed the new row", async () => {
  const legacyAttemptUsage = createTokenUsage();
  addUsageSample(legacyAttemptUsage, {
    input: 7,
    output: 0,
    total: 7,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
    provenance: "measured",
  });
  const checkpointUsage = structuredClone(legacyAttemptUsage);
  const checkpoint: RuntimeCheckpoint = {
    schemaVersion: 1,
    usage: checkpointUsage,
    phaseBudgets: {},
    attempts: {
      "root/call:0/workflow/call:0": [
        {
          attempt: 1,
          callHash: undefined,
          accountingScopeKey: "root/workflow-key:legacy-scope",
          status: "succeeded",
          usage: legacyAttemptUsage,
        },
      ],
    },
  };
  const child = `export const meta = { name: 'new-scope-child', description: 'new scope child' }
return await agent('same positional work', { label: 'new row' })`;
  let endedTokens: number | undefined;

  const result = await runWorkflow(parentScript("return await workflow('child', {}, { key: 'new-scope' })"), {
    loadSavedWorkflow: () => child,
    runtimeCheckpoint: checkpoint,
    persistLogs: false,
    onAgentEnd: (event) => {
      if (event.label === "new row") endedTokens = event.tokens;
    },
    agent: {
      async run(_prompt: string, options: { onUsage?: (value: AgentUsage) => void }) {
        options.onUsage?.(measured(5));
        return "new-result";
      },
    },
  });

  const newAttempts = Object.values(result.runtimeCheckpoint.attempts)
    .flat()
    .filter((attempt) => attempt.accountingScopeKey?.includes("workflow-key:") && attempt.usage.total === 5);
  assert.equal(endedTokens, 5);
  assert.equal(newAttempts.length, 1);
  assert.equal(newAttempts[0].attempt, 1);
  assert.equal(result.tokenUsage?.total, 12, "unattributable historical usage remains in the global total");
});

test("manager preserves unrelated raw script failures as non-recoverable execution errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-manager-raw-error-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-manager-raw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const manager = new WorkflowManager({ cwd });
      manager.on("error", () => {});
      let captured: WorkflowError | undefined;
      await assert.rejects(
        () =>
          manager.runSync(`export const meta = { name: 'raw-manager', description: 'raw manager' }
throw new Error('raw manager boom')`),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          captured = error;
          assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
          assert.equal(error.recoverable, false);
          assert.match(error.message, /raw manager boom/);
          assert.equal((error.cause as Error | undefined)?.message, "raw manager boom");
          return true;
        },
      );
      const run = manager.listRuns()[0];
      assert.equal(run.status, "failed");
      assert.equal(captured?.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("resume removes stale child rows that are absent from the changed child", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-changed-child-ui-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-changed-child-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      let child = `export const meta = { name: 'rows-child', description: 'two rows' }
await agent('kept work', { label: 'kept row' })
return await agent('removed work', { label: 'removed row' })`;
      const parent = parentScript("return await workflow('child', {}, { key: 'stable' })");
      const firstManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run(
            prompt: string,
            options: {
              onHistory?: (history: Array<{ role: string; kind: string; text: string }>) => void;
              onUsage?: (value: AgentUsage) => void;
            },
          ) {
            options.onHistory?.([{ role: "assistant", kind: "text", text: `${prompt} history` }]);
            options.onUsage?.(measured(prompt === "kept work" ? 4 : 6));
            return `${prompt} result`;
          },
        },
      });
      await firstManager.runSync(parent);
      const runId = firstManager.listRuns()[0].runId;
      const firstPersisted = firstManager.getPersistence().load(runId);
      assert.ok(firstPersisted);
      assert.equal(firstPersisted.agents.length, 2);
      firstManager.getPersistence().save({
        ...firstPersisted,
        status: "paused",
        result: undefined,
        completedAt: undefined,
      });

      child = `export const meta = { name: 'rows-child', description: 'one row' }
return await agent('kept work', { label: 'kept row' })`;
      let liveCalls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run() {
            liveCalls++;
            return "unexpected";
          },
        },
      });
      const completed = new Promise<void>((resolve) => resumedManager.once("complete", () => resolve()));
      assert.equal(await resumedManager.resume(runId), true);
      await completed;

      const resumed = resumedManager.getPersistence().load(runId);
      assert.equal(liveCalls, 0);
      assert.equal(resumed?.agents.length, 1);
      assert.equal(resumed?.agents[0].label, "kept row");
      assert.equal(resumed?.agents[0].tokens, 4);
      assert.equal(resumed?.agents[0].history?.[0]?.text, "kept work history");
      assert.equal(resumedManager.getSnapshot(runId)?.agentCount, 1);
      assert.equal(
        resumed?.journal?.some((entry) => entry.result === "removed work result"),
        true,
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("whole-wrapper replay reconciles only exact descendants from its latest completed generation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-exact-wrapper-rows-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-exact-wrapper-rows-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      let child = `export const meta = { name: 'exact-rows-child', description: 'two rows', phases: [{ title: 'Child' }] }
await agent('kept work', { label: 'kept row', model: 'provider/model-a' })
return await agent('removed work', { label: 'removed row' })`;
      const parent = parentScript(`await workflow('child', {}, { key: 'stable' })
return await agent('parent gate', { label: 'parent gate' })`);
      let parentGateFails = false;
      const childLiveCalls: string[] = [];
      const manager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run(
            prompt: string,
            options: {
              onHistory?: (history: Array<{ role: string; kind: string; text: string }>) => void;
              onUsage?: (value: AgentUsage) => void;
            },
          ) {
            if (prompt === "parent gate") {
              options.onUsage?.(measured(1));
              if (parentGateFails) {
                throw new WorkflowError(
                  "parent failed after wrapper journal",
                  WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
                  {
                    recoverable: false,
                  },
                );
              }
              return "parent succeeded";
            }
            childLiveCalls.push(prompt);
            options.onHistory?.([{ role: "assistant", kind: "text", text: `${prompt} history` }]);
            options.onUsage?.(measured(prompt === "kept work" ? 4 : 6));
            return `${prompt} result`;
          },
        },
      });

      await manager.runSync(parent);
      const runId = manager.listRuns()[0].runId;
      const firstPersisted = manager.getPersistence().load(runId);
      assert.ok(firstPersisted);
      assert.deepEqual(
        firstPersisted.agents.filter((agent) => agent.phase === "Child").map((agent) => agent.label),
        ["kept row", "removed row"],
      );

      child = `export const meta = { name: 'exact-rows-child', description: 'one row', phases: [{ title: 'Child' }] }
return await agent('kept work', { label: 'kept row', model: 'provider/model-a' })`;
      parentGateFails = true;
      manager.getPersistence().save({
        ...firstPersisted,
        status: "paused",
        result: undefined,
        completedAt: undefined,
      });
      const failed = new Promise<void>((resolve) => manager.once("error", () => resolve()));
      assert.equal(await manager.resume(runId), true);
      await failed;
      assert.equal(manager.getRun(runId)?.status, "failed");
      assert.deepEqual(childLiveCalls, ["kept work", "removed work"], "the changed child replays A without live usage");
      const failedPersisted = manager.getPersistence().load(runId);
      const latestWrapper = [...(failedPersisted?.journal ?? [])].reverse().find((entry) => entry.kind === "workflow");
      const keptIdentity = failedPersisted?.agents.find((agent) => agent.label === "kept row")?.accountingCallKey;
      assert.ok(keptIdentity);
      assert.deepEqual(latestWrapper?.descendantAgentAccountingCallKeys, [keptIdentity]);

      parentGateFails = false;
      const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
      assert.equal(await manager.resume(runId), true);
      await completed;

      const persisted = manager.getPersistence().load(runId);
      const childRows = persisted?.agents.filter((agent) => agent.phase === "Child") ?? [];
      assert.equal(persisted?.status, "completed");
      assert.equal(childRows.length, 1);
      assert.equal(childRows[0].label, "kept row");
      assert.equal(childRows[0].tokens, 4);
      assert.equal(childRows[0].model, "provider/model-a");
      assert.equal(childRows[0].phase, "Child");
      assert.equal(childRows[0].history?.[0]?.text, "kept work history");
      assert.equal(manager.getSnapshot(runId)?.agents.filter((agent) => agent.phase === "Child").length, 1);
      assert.deepEqual(childLiveCalls, ["kept work", "removed work"], "no child runs live on either resume");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("legacy wrappers without exact descendant identities preserve compatible restored rows", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-legacy-wrapper-rows-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-legacy-wrapper-rows-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const child = `export const meta = { name: 'legacy-rows-child', description: 'legacy rows child' }
await agent('legacy A', { label: 'legacy A' })
return await agent('legacy B', { label: 'legacy B' })`;
      const parent = parentScript("return await workflow('child', {}, { key: 'stable' })");
      const manager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run(prompt: string) {
            return `${prompt} result`;
          },
        },
      });

      await manager.runSync(parent);
      const runId = manager.listRuns()[0].runId;
      const persisted = manager.getPersistence().load(runId);
      assert.ok(persisted);
      for (const entry of persisted.journal ?? []) {
        if (entry.kind === "workflow") {
          delete (entry as JournalEntry & { descendantAgentAccountingCallKeys?: string[] })
            .descendantAgentAccountingCallKeys;
        }
      }
      manager.getPersistence().save({
        ...persisted,
        status: "paused",
        result: undefined,
        completedAt: undefined,
      });

      const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
      assert.equal(await manager.resume(runId), true);
      await completed;

      const rows = manager
        .getPersistence()
        .load(runId)
        ?.agents.filter((agent) => agent.label === "legacy A" || agent.label === "legacy B");
      assert.deepEqual(
        rows?.map((agent) => agent.label),
        ["legacy A", "legacy B"],
        "first compatible legacy replay must not delete valid descendant rows",
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("cold resume prefers resultPreview and falls back to legacy result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-cold-preview-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-cold-preview-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      let releaseFirst!: () => void;
      const firstPending = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt: string) {
            if (prompt === "first") await firstPending;
            return `${prompt} live`;
          },
        },
      });
      const runId = "cold-result-preview";
      const now = new Date().toISOString();
      manager.getPersistence().save({
        runId,
        workflowName: "cold-preview",
        script: `export const meta = { name: 'cold-preview', description: 'cold preview' }
await agent('first', { label: 'first' })
return await agent('second', { label: 'second' })`,
        status: "paused",
        phases: [],
        agents: [
          {
            id: 1,
            label: "first",
            prompt: "first",
            status: "done",
            result: "legacy first result",
            resultPreview: "persisted first preview",
            key: "root/call:0",
            accountingCallKey: "root/call:0",
          },
          {
            id: 2,
            label: "second",
            prompt: "second",
            status: "done",
            result: "legacy second result",
            key: "root/call:1",
            accountingCallKey: "root/call:1",
          },
        ],
        logs: [],
        startedAt: now,
        updatedAt: now,
      });

      const started = new Promise<void>((resolve) => manager.once("agentStart", () => resolve()));
      assert.equal(await manager.resume(runId), true);
      await started;
      const snapshot = manager.getSnapshot(runId);
      assert.equal(snapshot?.agents[0].resultPreview, "persisted first preview");
      assert.equal(snapshot?.agents[1].resultPreview, "legacy second result");
      const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
      releaseFirst();
      await completed;
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
