import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createTokenUsage, UsageController, type UsageSample } from "../src/usage.js";
import { type JournalEntry, runWorkflow, type SharedRuntime } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function measured(total: number): UsageSample {
  return {
    input: total,
    output: 0,
    total,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
    provenance: "measured",
  };
}

test("native Promise.all failure does not complete while a sibling agent invocation is live", async () => {
  const slowStarted = deferred<void>();
  const releaseSlow = deferred<void>();
  let slowSettled = false;
  const run = runWorkflow(
    `export const meta = { name: 'native_fail_fast', description: 'ownership' }
return await Promise.all([
  agent('fail', { label: 'fail' }),
  agent('slow', { label: 'slow' }),
])`,
    {
      concurrency: 2,
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          if (prompt === "slow") {
            slowStarted.resolve();
            await releaseSlow.promise;
            slowSettled = true;
            return "slow-done";
          }
          await slowStarted.promise;
          throw new WorkflowError("hard failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        },
      },
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

  await slowStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(runSettled, false, "the top-level run owns every live native-Promise branch");
  } finally {
    releaseSlow.resolve();
  }

  await assert.rejects(run, /hard failure/);
  assert.equal(slowSettled, true, "the sibling settles before the workflow rejects");
});

test("manager lease and deletion remain blocked until native Promise.all siblings settle", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-live-ownership-"));
  const slowStarted = deferred<void>();
  const releaseSlow = deferred<void>();
  const manager = new WorkflowManager({
    cwd,
    concurrency: 2,
    agent: {
      async run(prompt: string) {
        if (prompt === "slow") {
          slowStarted.resolve();
          await releaseSlow.promise;
          return "slow-done";
        }
        await slowStarted.promise;
        throw new WorkflowError("hard failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
      },
    },
  });
  manager.on("error", () => {});

  try {
    const { runId, promise } = manager.startInBackground(`export const meta = { name: 'lease', description: 'lease' }
return await Promise.all([agent('fail'), agent('slow')])`);
    await slowStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(manager.deleteRun(runId), false, "delete must not release the active generation's lease");
    releaseSlow.resolve();
    await assert.rejects(promise, /hard failure/);
    assert.equal(manager.deleteRun(runId), true, "delete is allowed only after all live invocations settle");
  } finally {
    releaseSlow.resolve();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stop retains the cross-manager lease through late usage settlement", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-stop-lease-"));
  const started = deferred<void>();
  const releaseAgent = deferred<void>();
  const finalUsage: AgentUsage = {
    input: 23,
    output: 14,
    total: 37,
    cost: 0.037,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const owner = new WorkflowManager({
    cwd,
    agent: {
      async run(
        _prompt: string,
        options: {
          signal?: AbortSignal;
          onUsage?: (usage: AgentUsage) => void;
          onUsageUpdate?: (usage: AgentUsage) => void;
        },
      ) {
        started.resolve();
        await releaseAgent.promise;
        assert.equal(options.signal?.aborted, true, "the slow runner observes the stop abort before settling");
        options.onUsageUpdate?.({ ...finalUsage, total: 31, output: 8 });
        options.onUsage?.(finalUsage);
        return "late-result";
      },
    },
  });
  owner.on("error", () => {});

  try {
    const { runId, promise } = owner.startInBackground(
      `export const meta = { name: 'stop_lease', description: 'stop lease ownership' }
return await agent('slow non-cooperative work')`,
    );
    await started.promise;
    const contender = new WorkflowManager({ cwd });

    assert.equal(owner.stop(runId), true);
    assert.ok(owner.getRun(runId)?.execution, "the stopped owner still has an unsettled execution");
    const earlyLease = contender.getPersistence().acquireRunLease(runId);
    if (earlyLease) contender.getPersistence().releaseRunLease(earlyLease);
    assert.equal(earlyLease, null, "another manager cannot acquire the stopped run before its attempt settles");
    assert.equal(contender.deleteRun(runId), false, "another manager cannot delete the unsettled stopped run");

    releaseAgent.resolve();
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    });

    const persisted = contender.getPersistence().load(runId);
    assert.equal(persisted?.status, "aborted");
    assert.equal(persisted?.tokenUsage?.total, 37, "late final usage is durable before ownership is released");
    assert.equal(persisted?.runtimeCheckpoint?.usage.total, 37, "the final checkpoint is durable too");

    const releasedLease = contender.getPersistence().acquireRunLease(runId);
    assert.ok(releasedLease, "the owner releases the lease after complete abort settlement");
    contender.getPersistence().releaseRunLease(releasedLease);
    assert.equal(contender.deleteRun(runId), true, "cross-manager cleanup proceeds after settlement");
  } finally {
    releaseAgent.resolve();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("manager drains an owned checkpoint but rejects its post-settlement agent continuation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-checkpoint-resume-"));
  const checkpointStarted = deferred<void>();
  const releaseCheckpoint = deferred<void>();
  let lateCalls = 0;
  let lateSettled = false;
  const manager = new WorkflowManager({
    cwd,
    concurrency: 2,
    agent: {
      async run(prompt: string) {
        if (prompt === "fail") {
          await checkpointStarted.promise;
          throw new WorkflowError("hard failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        }
        lateCalls++;
        await Promise.resolve();
        lateSettled = true;
        return "late-done";
      },
    },
  });
  manager.on("error", () => {});

  try {
    const { runId, promise } = manager.startInBackground(
      `export const meta = { name: 'checkpoint_resume', description: 'checkpoint ownership' }
return await Promise.all([
  agent('fail'),
  (async () => {
    await checkpoint('continue?')
    await Promise.resolve()
    return await agent('late')
  })(),
])`,
      undefined,
      {
        confirm: async () => {
          checkpointStarted.resolve();
          await releaseCheckpoint.promise;
          return true;
        },
      },
    );
    let originalSettled = false;
    void promise.then(
      () => {
        originalSettled = true;
      },
      () => {
        originalSettled = true;
      },
    );

    await checkpointStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeRelease = originalSettled;
    const statusBeforeRelease = manager.getRun(runId)?.status;
    const resumeAllowed = await manager.resume(runId);
    const resumedExecution = manager.getRun(runId)?.execution;

    releaseCheckpoint.resolve();
    await Promise.allSettled([promise, ...(resumedExecution ? [resumedExecution] : [])]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(settledBeforeRelease, false, "the manager run must remain unsettled while checkpoint() is pending");
    assert.equal(statusBeforeRelease, "running");
    assert.equal(resumeAllowed, false, "resume must not start another generation while checkpoint() owns a branch");
    assert.equal(lateCalls, 0, "the terminal admission barrier rejects the post-settlement agent");
    assert.equal(lateSettled, false, "no agent work starts after root script settlement");
  } finally {
    releaseCheckpoint.resolve();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("manager blocks deletion until checkpoint settlement and rejects post-barrier work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-checkpoint-delete-"));
  const checkpointStarted = deferred<void>();
  const releaseCheckpoint = deferred<void>();
  let lateCalls = 0;
  const manager = new WorkflowManager({
    cwd,
    concurrency: 2,
    agent: {
      async run(prompt: string) {
        if (prompt === "fail") {
          await checkpointStarted.promise;
          throw new WorkflowError("hard failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        }
        lateCalls++;
        return "late-done";
      },
    },
  });
  manager.on("error", () => {});

  try {
    const { runId, promise } = manager.startInBackground(
      `export const meta = { name: 'checkpoint_delete', description: 'checkpoint ownership' }
return await Promise.all([
  agent('fail'),
  (async () => {
    await checkpoint('continue?')
    await Promise.resolve()
    return await agent('late')
  })(),
])`,
      undefined,
      {
        confirm: async () => {
          checkpointStarted.resolve();
          await releaseCheckpoint.promise;
          return true;
        },
      },
    );

    await checkpointStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const deleteBeforeRelease = manager.deleteRun(runId);

    releaseCheckpoint.resolve();
    await assert.rejects(promise, /hard failure/);
    const callsAtSettlement = lateCalls;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(deleteBeforeRelease, false, "delete must remain blocked while checkpoint() owns a branch");
    assert.equal(callsAtSettlement, 0, "the post-checkpoint agent is rejected by terminal admission");
    assert.equal(lateCalls, callsAtSettlement, "no work may launch after settlement and store cleanup");
    assert.equal(manager.deleteRun(runId), true, "delete succeeds after the complete child lifetime settles");
  } finally {
    releaseCheckpoint.resolve();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("native failure waits for a nested workflow's complete child lifetime without self-deadlock", async () => {
  const childWaiting = deferred<void>();
  const releaseChild = deferred<void>();
  let lateSettled = false;
  const child = `export const meta = { name: 'owned_child', description: 'owned child' }
await Promise.resolve()
return await agent('nested late')`;
  const parent = `export const meta = { name: 'owned_parent', description: 'owned parent' }
return await Promise.all([agent('fail'), workflow('child')])`;
  const run = runWorkflow(parent, {
    concurrency: 2,
    loadSavedWorkflow: () => child,
    persistLogs: false,
    agent: {
      async run(prompt: string) {
        if (prompt === "fail") {
          await childWaiting.promise;
          throw new WorkflowError("hard failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        }
        childWaiting.resolve();
        await releaseChild.promise;
        lateSettled = true;
        return "nested-done";
      },
    },
  });
  let runSettled = false;
  void run.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );

  await childWaiting.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(runSettled, false, "the root retains ownership of the pending child workflow");
  } finally {
    releaseChild.resolve();
  }

  await assert.rejects(run, /hard failure/);
  assert.equal(lateSettled, true, "the child and its continuation settle before the root rejects");
});

test("delayed telemetry from attempt 1 cannot charge attempt 2", async () => {
  const secondStarted = deferred<void>();
  const releaseSecond = deferred<void>();
  let calls = 0;
  let delayedFirstUsage: ((usage: AgentUsage) => void) | undefined;

  const run = runWorkflow(
    `export const meta = { name: 'attempt_generation', description: 'stale callbacks' }
return await agent('work', { label: 'worker', retries: 1 })`,
    {
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
          calls++;
          if (calls === 1) {
            delayedFirstUsage = options.onUsage;
            return "";
          }
          secondStarted.resolve();
          await releaseSecond.promise;
          options.onUsage?.({ input: 20, output: 0, total: 20, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return "ok";
        },
      },
    },
  );

  await secondStarted.promise;
  delayedFirstUsage?.({ input: 100, output: 0, total: 100, cost: 0, cacheRead: 0, cacheWrite: 0 });
  releaseSecond.resolve();
  const result = await run;
  const attempts = result.runtimeCheckpoint.attempts["root/call:0"] ?? [];

  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.usage.total, 20, "attempt 2 only contains its own provider telemetry");
  assert.equal(result.tokenUsage?.total, (attempts[0]?.usage.total ?? 0) + 20);
});

test("budget exhaustion reports current final overshoot instead of its first threshold snapshot", () => {
  const controller = new UsageController({ tokenBudget: 100 });
  const firstStarted = controller.startAttempt("first", 1, "first-hash", undefined, new AbortController());
  const secondStarted = controller.startAttempt("second", 1, "second-hash", undefined, new AbortController());
  const firstAttempt = (firstStarted as unknown as string | undefined) ?? "first";
  const secondAttempt = (secondStarted as unknown as string | undefined) ?? "second";

  controller.updateAttempt(firstAttempt, measured(60), true);
  controller.updateAttempt(secondAttempt, measured(60), true);
  controller.updateAttempt(secondAttempt, measured(80), false);

  assert.deepEqual(controller.exhaustionFor(firstAttempt), {
    scope: "run",
    limit: 100,
    spent: 140,
    overshoot: 40,
  });
});

test("top-level budget error is refreshed after delayed final usage settles", async () => {
  const bothStarted = deferred<void>();
  let started = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'final_overshoot', description: 'final overshoot' }
return await Promise.all([agent('fast'), agent('delayed')])`,
        {
          concurrency: 2,
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(
              prompt: string,
              options: {
                signal?: AbortSignal;
                onUsage?: (usage: AgentUsage) => void;
                onUsageUpdate?: (usage: AgentUsage) => void;
              },
            ) {
              started++;
              if (started === 2) bothStarted.resolve();
              await bothStarted.promise;
              options.onUsageUpdate?.({ input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 });
              if (prompt === "delayed") {
                await new Promise<void>((resolve) => setImmediate(resolve));
                options.onUsage?.({ input: 80, output: 0, total: 80, cost: 0, cacheRead: 0, cacheWrite: 0 });
              }
              throw new Error(options.signal?.aborted ? "aborted at budget" : "provider failed");
            },
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      assert.equal(error.usage?.total, 140);
      assert.equal(error.overshoot, 40);
      return true;
    },
  );
});

test("same-title nested phases have independent durable hierarchical budgets", async () => {
  const child = `export const meta = { name: 'child', description: 'child' }
phase('Shared title', { budget: 100 })
return await agent('child work', { label: 'child' })`;
  const parent = `export const meta = { name: 'parent', description: 'parent' }
return await Promise.all([workflow('left'), workflow('right')])`;
  const journal: JournalEntry[] = [];
  const first = await runWorkflow(parent, {
    concurrency: 2,
    loadSavedWorkflow: () => child,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
        options.onUsage?.({ input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 });
        return "ok";
      },
    },
  });

  const firstBudgets = Object.entries(first.runtimeCheckpoint.phaseBudgets);
  assert.equal(firstBudgets.length, 2, "parallel child scopes must not collide by display title");
  assert.deepEqual(
    firstBudgets.map(([, value]) => value.charged).sort((a, b) => a - b),
    [60, 60],
  );
  assert.ok(
    firstBudgets.every(([, value]) => value.title === "Shared title"),
    "UI title is retained separately",
  );

  const resumed = await runWorkflow(parent, {
    maxAgents: 2,
    loadSavedWorkflow: () => child,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
    runtimeCheckpoint: first.runtimeCheckpoint,
    agent: {
      async run() {
        throw new Error("resume should replay both child wrappers");
      },
    },
  });
  assert.deepEqual(resumed.runtimeCheckpoint.phaseBudgets, first.runtimeCheckpoint.phaseBudgets);
});

test("phase charges survive insertion, reordering, and resume by stable title identity", async () => {
  const initialScript = `export const meta = { name: 'phase_identity', description: 'initial', phases: [{ title: 'Alpha' }, { title: 'Beta' }] }
phase('Alpha', { budget: 100 })
await agent('alpha')
phase('Beta', { budget: 100 })
await agent('beta')
return 'initial'`;
  const initial = await runWorkflow(initialScript, {
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
        const total = prompt === "alpha" ? 20 : 30;
        options.onUsage?.({ input: total, output: 0, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
        return "ok";
      },
    },
  });
  const reorderedScript = `export const meta = { name: 'phase_identity', description: 'reordered', phases: [{ title: 'Inserted' }, { title: 'Beta' }, { title: 'Alpha' }] }
phase('Inserted', { budget: 100 })
phase('Beta', { budget: 100 })
phase('Alpha', { budget: 100 })
return 'resumed'`;

  const reordered = await runWorkflow(reorderedScript, {
    persistLogs: false,
    runtimeCheckpoint: initial.runtimeCheckpoint,
  });
  const resumed = await runWorkflow(reorderedScript, {
    persistLogs: false,
    runtimeCheckpoint: reordered.runtimeCheckpoint,
  });
  const charges = Object.fromEntries(
    Object.values(reordered.runtimeCheckpoint.phaseBudgets).map((phaseBudget) => [
      phaseBudget.title,
      phaseBudget.charged,
    ]),
  );

  assert.deepEqual(charges, { Alpha: 20, Beta: 30, Inserted: 0 });
  assert.deepEqual(resumed.runtimeCheckpoint.phaseBudgets, reordered.runtimeCheckpoint.phaseBudgets);
});

test("legacy ordinal phase charges migrate only by an unambiguous matching stored title", async () => {
  const legacyCheckpoint = {
    schemaVersion: 1 as const,
    usage: createTokenUsage(),
    phaseBudgets: {
      "root/phase:0": { title: "Build", budget: 100, charged: 60, warned: false },
      "root/phase:1": { title: "Other", budget: 100, charged: 10, warned: false },
    },
    attempts: {},
  };
  const result = await runWorkflow(
    `export const meta = { name: 'legacy_phase', description: 'legacy migration', phases: [{ title: 'Inserted' }, { title: 'Build' }] }
phase('Inserted', { budget: 100 })
phase('Build', { budget: 100 })
return 'done'`,
    { persistLogs: false, runtimeCheckpoint: legacyCheckpoint },
  );
  const states = Object.values(result.runtimeCheckpoint.phaseBudgets);

  assert.deepEqual(Object.fromEntries(states.map((state) => [state.title, state.charged])), {
    Build: 60,
    Inserted: 0,
    Other: 10,
  });
});

test("ambiguous legacy ordinal phase titles do not transfer either charge", async () => {
  const legacyCheckpoint = {
    schemaVersion: 1 as const,
    usage: createTokenUsage(),
    phaseBudgets: {
      "root/phase:0": { title: "Build", budget: 100, charged: 60, warned: false },
      "root/phase:1": { title: "Build", budget: 100, charged: 30, warned: false },
    },
    attempts: {},
  };
  const result = await runWorkflow(
    `export const meta = { name: 'ambiguous_phase', description: 'ambiguous migration', phases: [{ title: 'Build' }] }
phase('Build', { budget: 100 })
return 'done'`,
    { persistLogs: false, runtimeCheckpoint: legacyCheckpoint },
  );

  assert.deepEqual(
    Object.values(result.runtimeCheckpoint.phaseBudgets)
      .map((state) => state.charged)
      .sort((a, b) => a - b),
    [0, 30, 60],
  );
});

test("nested wrapper replay persists the complete child logical-call count", async () => {
  const child = `export const meta = { name: 'child_count', description: 'child count' }
await checkpoint('continue?', { default: true })
await agent('recoverable failure', { label: 'recoverable', retries: 1 })
return 'child-done'`;
  const parent = `export const meta = { name: 'parent_count', description: 'parent count' }
return await workflow('child')`;
  const journal: JournalEntry[] = [];
  const first = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "";
      },
    },
  });
  const wrapper = journal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");

  assert.equal(first.agentCount, 2, "checkpoint and recoverable logical agent both count");
  assert.equal(wrapper?.agentCount, 2, "wrapper stores the child result's complete logical-call count directly");

  await assert.rejects(
    () =>
      runWorkflow(parent, {
        maxAgents: 1,
        loadSavedWorkflow: () => child,
        persistLogs: false,
        resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
        runtimeCheckpoint: first.runtimeCheckpoint,
        agent: {
          async run() {
            throw new Error("wrapper must reject before live work");
          },
        },
      }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
  );
});

test("nested phase ownership follows stable child identity across reorder, insertion, and resume", async () => {
  const initialChildren: Record<string, string> = {
    left: `export const meta = { name: 'left', description: 'left initial' }
phase('Shared', { budget: 100 })
return await agent('left initial')`,
    right: `export const meta = { name: 'right', description: 'right initial' }
phase('Shared', { budget: 100 })
return await agent('right initial')`,
  };
  const initialParent = `export const meta = { name: 'parent', description: 'initial order' }
return await Promise.all([
  workflow('left', { side: 'left', normalized: { a: 1, b: 2 } }),
  workflow('right', { side: 'right', normalized: { a: 1, b: 2 } }),
])`;
  const initial = await runWorkflow(initialParent, {
    concurrency: 2,
    loadSavedWorkflow: (name) => initialChildren[name],
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
        const total = prompt === "left initial" ? 10 : 20;
        options.onUsage?.({ input: total, output: 0, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
        return "ok";
      },
    },
  });
  const initialCharges = Object.entries(initial.runtimeCheckpoint.phaseBudgets);
  const leftKey = initialCharges.find(([, state]) => state.charged === 10)?.[0];
  const rightKey = initialCharges.find(([, state]) => state.charged === 20)?.[0];
  assert.ok(leftKey && rightKey && leftKey !== rightKey);

  const updatedChildren: Record<string, string> = {
    inserted: `export const meta = { name: 'inserted', description: 'inserted' }
phase('Shared', { budget: 100 })
return await agent('inserted increment')`,
    left: `export const meta = { name: 'left', description: 'left increment' }
phase('Shared', { budget: 100 })
return await agent('left increment')`,
    right: `export const meta = { name: 'right', description: 'right increment' }
phase('Shared', { budget: 100 })
return await agent('right increment')`,
  };
  const reorderedParent = `export const meta = { name: 'parent', description: 'inserted and reordered' }
return await Promise.all([
  workflow('inserted', { side: 'inserted' }),
  workflow('right', { normalized: { b: 2, a: 1 }, side: 'right' }),
  workflow('left', { normalized: { b: 2, a: 1 }, side: 'left' }),
])`;
  const journal: JournalEntry[] = [];
  const reordered = await runWorkflow(reorderedParent, {
    concurrency: 3,
    loadSavedWorkflow: (name) => updatedChildren[name],
    runtimeCheckpoint: initial.runtimeCheckpoint,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
        const total = prompt === "inserted increment" ? 3 : 1;
        options.onUsage?.({ input: total, output: 0, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
        return "ok";
      },
    },
  });

  assert.equal(reordered.runtimeCheckpoint.phaseBudgets[leftKey].charged, 11, "left keeps its own prior charge");
  assert.equal(reordered.runtimeCheckpoint.phaseBudgets[rightKey].charged, 21, "right keeps its own prior charge");
  assert.deepEqual(
    Object.values(reordered.runtimeCheckpoint.phaseBudgets)
      .map((state) => state.charged)
      .sort((a, b) => a - b),
    [3, 11, 21],
  );

  let replayCalls = 0;
  const resumed = await runWorkflow(reorderedParent, {
    concurrency: 3,
    loadSavedWorkflow: (name) => updatedChildren[name],
    runtimeCheckpoint: reordered.runtimeCheckpoint,
    resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
    persistLogs: false,
    agent: {
      async run() {
        replayCalls++;
        throw new Error("stable wrapper replay must perform no live child work");
      },
    },
  });
  assert.equal(replayCalls, 0);
  assert.equal(resumed.runtimeCheckpoint.phaseBudgets[leftKey].charged, 11);
  assert.equal(resumed.runtimeCheckpoint.phaseBudgets[rightKey].charged, 21);
});

test("ambiguous legacy positional nested phase charges are never transferred by child position", async () => {
  const legacyCheckpoint = {
    schemaVersion: 1 as const,
    usage: createTokenUsage(),
    phaseBudgets: {
      "root/call:0/workflow/phase:Shared": { title: "Shared", budget: 100, charged: 10, warned: false },
      "root/call:1/workflow/phase:Shared": { title: "Shared", budget: 100, charged: 20, warned: false },
    },
    attempts: {},
  };
  const child = `export const meta = { name: 'legacy_child', description: 'legacy child' }
phase('Shared', { budget: 100 })
return 'done'`;
  const result = await runWorkflow(
    `export const meta = { name: 'legacy_parent', description: 'legacy parent' }
return await Promise.all([workflow('right'), workflow('left')])`,
    {
      concurrency: 2,
      loadSavedWorkflow: () => child,
      runtimeCheckpoint: legacyCheckpoint,
      persistLogs: false,
    },
  );

  assert.deepEqual(
    Object.values(result.runtimeCheckpoint.phaseBudgets)
      .map((state) => state.charged)
      .sort((a, b) => a - b),
    [0, 0, 10, 20],
  );
  assert.equal(result.runtimeCheckpoint.phaseBudgets["root/call:0/workflow/phase:Shared"].charged, 10);
  assert.equal(result.runtimeCheckpoint.phaseBudgets["root/call:1/workflow/phase:Shared"].charged, 20);
});

test("nested wrapper drains caught fail-fast descendants before committing usage and store delta", async () => {
  const lateStarted = deferred<void>();
  const journal: JournalEntry[] = [];
  let calls = 0;
  const child = `export const meta = { name: 'atomic_child', description: 'atomic child' }
let caught = false
try {
  await Promise.all([agent('caught failure'), agent('late sibling')])
} catch { caught = true }
return { caught }`;
  const parent = `export const meta = { name: 'atomic_parent', description: 'atomic parent' }
return await workflow('child', { identity: 'atomic' })`;
  const first = await runWorkflow(parent, {
    concurrency: 2,
    loadSavedWorkflow: () => child,
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
    agent: {
      async run(
        prompt: string,
        options: {
          onUsage?: (usage: AgentUsage) => void;
          systemTools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
        },
      ) {
        calls++;
        if (prompt === "late sibling") {
          lateStarted.resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          await options.systemTools
            ?.find((tool) => tool.name === "store_put")
            ?.execute("", {
              key: "late-key",
              value: "late-value",
            });
          options.onUsage?.({ input: 5, output: 0, total: 5, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return "late-success";
        }
        await lateStarted.promise;
        options.onUsage?.({ input: 7, output: 0, total: 7, cost: 0, cacheRead: 0, cacheWrite: 0 });
        throw new WorkflowError("caught failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      },
    },
  });
  const wrapper = journal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");

  assert.equal((first.result as { caught?: boolean }).caught, true);
  assert.equal(calls, 2);
  assert.equal(wrapper?.tokens, 12, "caught failures and delayed successes both belong to wrapper usage");
  assert.deepEqual(wrapper?.storeDelta, { "late-key": "late-value" });
  assert.equal(journal.at(-1)?.kind, "workflow", "wrapper commits only after all descendant journals are stable");

  let replayCalls = 0;
  const replayed = await runWorkflow(parent, {
    loadSavedWorkflow: () => child,
    runtimeCheckpoint: first.runtimeCheckpoint,
    resumeJournal: new Map(journal.map((entry) => [entry.key as string, entry])),
    persistLogs: false,
    agent: {
      async run() {
        replayCalls++;
        throw new Error("wrapper replay must perform zero live work");
      },
    },
  });
  assert.equal((replayed.result as { caught?: boolean }).caught, true);
  assert.equal(replayCalls, 0);
});

test("nested wrapper usage includes a caught failed attempt followed by a success", async () => {
  const journal: JournalEntry[] = [];
  const child = `export const meta = { name: 'caught_usage_child', description: 'caught usage child' }
try { await agent('failure') } catch {}
return await agent('success')`;
  await runWorkflow(
    `export const meta = { name: 'caught_usage_parent', description: 'caught usage parent' }
return await workflow('child')`,
    {
      loadSavedWorkflow: () => child,
      onAgentJournal: (entry) => journal.push(entry),
      persistLogs: false,
      agent: {
        async run(prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
          const total = prompt === "failure" ? 7 : 5;
          options.onUsage?.({ input: total, output: 0, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
          if (prompt === "failure") {
            throw new WorkflowError("caught", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          }
          return "ok";
        },
      },
    },
  );

  const wrapper = journal.find((entry) => entry.kind === "workflow" && entry.key === "root/call:0");
  assert.equal(wrapper?.tokens, 12);
});

test("final measured usage exhaustion aborts an active sibling and preserves the honest overshoot", async () => {
  const bothStarted = deferred<void>();
  let started = 0;
  let siblingObservedAbort = false;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'final_only_exhaustion', description: 'final-only exhaustion' }
return await Promise.all([agent('final jump'), agent('active sibling')])`,
        {
          concurrency: 2,
          tokenBudget: 100,
          persistLogs: false,
          agent: {
            async run(
              prompt: string,
              options: {
                signal?: AbortSignal;
                onUsage?: (usage: AgentUsage) => void;
                onUsageUpdate?: (usage: AgentUsage) => void;
              },
            ) {
              started++;
              if (started === 2) bothStarted.resolve();
              await bothStarted.promise;
              if (prompt === "final jump") {
                options.onUsageUpdate?.({ input: 40, output: 0, total: 40, cost: 0, cacheRead: 0, cacheWrite: 0 });
                options.onUsage?.({ input: 120, output: 0, total: 120, cost: 0, cacheRead: 0, cacheWrite: 0 });
                return "final";
              }
              await new Promise<void>((resolve) => {
                const fallback = setTimeout(resolve, 50);
                const finish = () => {
                  siblingObservedAbort = options.signal?.aborted ?? false;
                  clearTimeout(fallback);
                  resolve();
                };
                if (options.signal?.aborted) finish();
                else options.signal?.addEventListener("abort", finish, { once: true });
              });
              throw new Error(siblingObservedAbort ? "aborted by final usage" : "sibling was not aborted");
            },
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      assert.equal(error.usage?.total, 120);
      assert.equal(error.overshoot, 20);
      return true;
    },
  );
  assert.equal(siblingObservedAbort, true);
});

test("legacy SharedRuntime works at runtime and keeps compatibility counters synchronized", async () => {
  const tokenUsage = createTokenUsage();
  const sharedRuntime: SharedRuntime = {
    limiter: async (fn) => fn(),
    agentCount: 0,
    spent: 0,
    tokenUsage,
    depth: 0,
  };

  const result = await runWorkflow(
    `export const meta = { name: 'legacy_runtime', description: 'legacy runtime' }
return await agent('work')`,
    {
      sharedRuntime,
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
          options.onUsage?.({ input: 7, output: 3, total: 10, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return "ok";
        },
      },
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(sharedRuntime.spent, 10);
  assert.equal(sharedRuntime.tokenUsage.total, 10);
  assert.equal(sharedRuntime.depth, 0);
});

test("historical public API shapes compile", () => {
  const cwd = join(import.meta.dirname, "..");
  execFileSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--project", "tests/fixtures/public-api-compat.json"],
    {
      cwd,
      stdio: "pipe",
    },
  );
});
