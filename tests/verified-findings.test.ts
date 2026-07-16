import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { JournalEntry, WorkflowPhaseBudget } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const twoAgentScript = `export const meta = { name: 'limits', description: 'limits' }
await agent('first')
return await agent('second')`;

test("maxAgents is normalized to a finite positive capped integer at tool, manager, and runtime boundaries", async () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as ((args: unknown) => { maxAgents?: number }) | undefined;
  assert.ok(prepare);
  assert.equal(prepare({ script: twoAgentScript, maxAgents: 1.5 }).maxAgents, 1);
  assert.equal(prepare({ script: twoAgentScript, maxAgents: Number.POSITIVE_INFINITY }).maxAgents, 1);
  assert.equal(prepare({ script: twoAgentScript, maxAgents: 1_001 }).maxAgents, 1_000);

  for (const maxAgents of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    let calls = 0;
    await assert.rejects(
      () =>
        runWorkflow(twoAgentScript, {
          maxAgents,
          persistLogs: false,
          agent: {
            async run() {
              calls++;
              return "ok";
            },
          },
        }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
    );
    assert.equal(calls, 1, `maxAgents=${String(maxAgents)} must admit exactly one agent`);
  }

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-max-agents-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-max-agents-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run() {
            return "ok";
          },
        },
      });
      await manager.runSync(
        `export const meta = { name: 'persisted-limit', description: 'persisted limit' }
return await agent('one')`,
        undefined,
        { maxAgents: 1_001.75 },
      );
      assert.equal(manager.listRuns()[0].executionPolicy?.maxAgents, 1_000);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("workflow args reject functions, cycles, Dates, and custom objects before replay or provider work", async () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  class CustomArgs {
    value = 1;
  }
  const invalidArgs: unknown[] = [() => "a", cycle, new Date("2026-01-01T00:00:00Z"), new CustomArgs()];
  const cached: JournalEntry = {
    index: 0,
    hash: "unsupported values must never reach replay hashing",
    result: "cached",
  };

  for (const args of invalidArgs) {
    let calls = 0;
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'json-args', description: 'json args' }
return await agent('work')`,
          {
            args,
            persistLogs: false,
            resumeJournal: new Map([[0, cached]]),
            agent: {
              async run() {
                calls++;
                return "live";
              },
            },
          },
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        /args.*JSON/i.test(error.message),
    );
    assert.equal(calls, 0);
  }

  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as ((args: unknown) => unknown) | undefined;
  assert.ok(prepare);
  assert.throws(() => prepare({ script: twoAgentScript, args: new Date() }), /args.*JSON/i);
});

test("hostile phase titles survive parent and child budget reconstruction", async () => {
  const titles = ["__proto__", "constructor", "prototype"];
  const childScript = `export const meta = { name: 'child', description: 'child' }
for (const title of ${JSON.stringify(titles)}) {
  phase(title, { budget: 100 })
  await agent('child-' + title)
}
return 'child-done'`;
  const parentScript = `export const meta = { name: 'phase-maps', description: 'phase maps' }
for (const title of ${JSON.stringify(titles)}) {
  phase(title, { budget: 100 })
  await agent('parent-' + title)
}
return await workflow('child')`;

  const runOnce = async (initialPhaseBudgets?: Readonly<Record<string, WorkflowPhaseBudget>>) => {
    const progress = Object.create(null) as Record<string, WorkflowPhaseBudget>;
    await runWorkflow(parentScript, {
      runId: "hostile-phase-titles",
      persistLogs: false,
      initialPhaseBudgets,
      loadSavedWorkflow: () => childScript,
      onPhaseBudgetProgress: (title, budget) => {
        progress[title] = { ...budget };
      },
      agent: {
        async run(_prompt, options) {
          options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
          return "ok";
        },
      },
    });
    return progress;
  };

  const first = await runOnce();
  for (const title of titles) assert.deepEqual(first[title], { budget: 100, spent: 1, warned: false });
  const childKeys = Object.keys(first).filter((key) => key.startsWith("@workflow-child-phase/"));
  assert.equal(childKeys.length, titles.length);

  const second = await runOnce(first);
  for (const title of titles) assert.deepEqual(second[title], { budget: 100, spent: 2, warned: false });
  for (const key of childKeys) assert.deepEqual(second[key], { budget: 100, spent: 2, warned: false });

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-phase-map-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-phase-map-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(_prompt, options) {
            options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
            return "ok";
          },
        },
      });
      await manager.runSync(
        `export const meta = { name: 'hostile-parent', description: 'hostile parent' }
for (const title of ${JSON.stringify(titles)}) {
  phase(title, { budget: 100 })
  await agent(title)
}
return 'done'`,
      );
      const persisted = manager.listRuns()[0].phaseBudgets;
      assert.ok(persisted);
      for (const title of titles) {
        assert.ok(Object.hasOwn(persisted, title));
        assert.deepEqual(persisted[title], { budget: 100, spent: 1, warned: false });
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: {} }) as never,
    getSkills: () => ({ skills: [], diagnostics: [] }) as never,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function modelRegistry(...models: Model<unknown>[]) {
  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
  } as never;
}

function meteredWorkflowAgent(
  cwd: string,
  models: Model<unknown>[],
  totals: number[],
  sessionStarts: { value: number },
) {
  const registry = modelRegistry(...models);
  const agent = new WorkflowAgent({
    cwd,
    modelRegistry: registry,
    strictModelResolution: true,
    resourceLoaderFactory: () => fakeLoader(),
    sessionFactory: async (options: CreateAgentSessionOptions) => {
      sessionStarts.value++;
      const total = totals.shift() ?? 0;
      const session = {
        model: options.model,
        thinkingLevel: options.thinkingLevel ?? "medium",
        systemPrompt: "",
        messages: [] as unknown[],
        prompt: async () => {
          session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
        },
        abort: async () => {},
        subscribe: () => () => {},
        getActiveToolNames: () => [],
        getSessionStats: () => ({
          tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
          cost: 0,
        }),
        dispose: () => {},
      };
      return { session, extensionsResult: fakeLoader().getExtensions() } as never;
    },
  });
  return { agent, registry };
}

test("pre-session strict model failures spend zero tokens and do not poison budget resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-zero-token-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-zero-token-home-"));
  const target = { provider: "mock", id: "target", name: "Target" } as Model<unknown>;
  const later = { provider: "mock", id: "later", name: "Later" } as Model<unknown>;
  const script = `export const meta = { name: 'zero-token-resume', description: 'zero token resume' }
await agent('first', { model: 'mock/target' })
await agent('strict failure', { model: 'mock/later' })
return await agent('after', { model: 'mock/target' })`;

  try {
    await withFakeHomeAsync(home, async () => {
      let setupSessionStarts = 0;
      const setupFailureAgent = new WorkflowAgent({
        cwd,
        modelRegistry: modelRegistry(target),
        strictModelResolution: true,
        resourceLoaderFactory: () => {
          const loader = fakeLoader();
          loader.reload = async () => {
            throw new Error("resource setup failed");
          };
          return loader;
        },
        sessionFactory: async () => {
          setupSessionStarts++;
          throw new Error("session must not start");
        },
      });
      const setupUsage: number[] = [];
      const setupResult = await runWorkflow(
        `export const meta = { name: 'setup-failure', description: 'setup failure' }
return await agent('work', { model: 'mock/target' })`,
        {
          agent: setupFailureAgent,
          modelRegistry: modelRegistry(target),
          strictModelResolution: true,
          persistLogs: false,
          onTokenUsageProgress: (usage) => setupUsage.push(usage.total),
        },
      );
      assert.equal(setupResult.result, null);
      assert.equal(setupSessionStarts, 0);
      assert.deepEqual(setupUsage, [0], "pre-session setup failures must be durably recorded as zero tokens");

      const firstStarts = { value: 0 };
      const firstRuntime = meteredWorkflowAgent(cwd, [target], [4], firstStarts);
      const first = new WorkflowManager({
        cwd,
        agent: firstRuntime.agent,
        modelRegistry: firstRuntime.registry,
        strictModelResolution: true,
      });
      first.on("error", () => {});
      await assert.rejects(
        () => first.runSync(script, undefined, { tokenBudget: 6 }),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      );
      const failed = first.listRuns()[0];
      assert.equal(firstStarts.value, 1, "strict resolution must fail before a second session starts");
      assert.equal(failed.tokenUsage?.total, 4, "the pre-session failure must add zero prompt-estimate tokens");

      const resumedStarts = { value: 0 };
      const resumedRuntime = meteredWorkflowAgent(cwd, [target, later], [1, 1], resumedStarts);
      const resumed = new WorkflowManager({
        cwd,
        agent: resumedRuntime.agent,
        modelRegistry: resumedRuntime.registry,
        strictModelResolution: true,
      });
      const completed = new Promise<void>((resolve) => {
        resumed.on("complete", (event: { runId: string }) => event.runId === failed.runId && resolve());
      });
      assert.equal(await resumed.resume(failed.runId), true);
      await completed;
      assert.equal(resumedStarts.value, 2);
      assert.equal(resumed.getPersistence().load(failed.runId)?.tokenUsage?.total, 6);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("nested workflow success, replay, and caught failure restore the parent phase in callbacks and reports", async () => {
  const successChild = `export const meta = { name: 'child', description: 'child' }
phase('Child')
return await agent('child')`;
  const parent = `export const meta = { name: 'parent-phase', description: 'parent phase' }
phase('Parent')
await workflow('child')
return await agent('parent-after')`;
  const journal: JournalEntry[] = [];
  const livePhases: Array<string | undefined> = [];
  const liveAgents: Array<string | undefined> = [];
  await runWorkflow(parent, {
    persistLogs: false,
    loadSavedWorkflow: () => successChild,
    onAgentJournal: (entry) => journal.push(entry),
    onPhase: (title) => livePhases.push(title),
    onAgentStart: (event) => liveAgents.push(event.phase),
    agent: {
      async run(prompt) {
        return prompt;
      },
    },
  });
  assert.equal(livePhases.at(-1), "Parent");
  assert.equal(liveAgents.at(-1), "Parent");

  const replayPhases: Array<string | undefined> = [];
  const replayAgents: Array<string | undefined> = [];
  await runWorkflow(parent, {
    persistLogs: false,
    loadSavedWorkflow: () => successChild,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    onPhase: (title) => replayPhases.push(title),
    onAgentStart: (event) => replayAgents.push(event.phase),
    agent: {
      async run(prompt) {
        return prompt;
      },
    },
  });
  assert.equal(replayPhases.at(-1), "Parent");
  assert.equal(replayAgents.at(-1), "Parent");

  const failingChild = `export const meta = { name: 'failing-child', description: 'failing child' }
phase('Child failure')
return await agent('fail-child')`;
  const caughtParent = `export const meta = { name: 'caught-child', description: 'caught child' }
phase('Parent failure')
try { await workflow('child') } catch {}
return await agent('parent-survives')`;
  const failurePhases: Array<string | undefined> = [];
  const failureAgents: Array<string | undefined> = [];
  await runWorkflow(caughtParent, {
    persistLogs: false,
    loadSavedWorkflow: () => failingChild,
    onPhase: (title) => failurePhases.push(title),
    onAgentStart: (event) => failureAgents.push(event.phase),
    agent: {
      async run(prompt) {
        if (prompt === "fail-child") {
          throw new WorkflowError("pre-provider failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
          });
        }
        return prompt;
      },
    },
  });
  assert.equal(failurePhases.at(-1), "Parent failure");
  assert.equal(failureAgents.at(-1), "Parent failure");

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-parent-phase-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-parent-phase-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const manager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => successChild,
        agent: {
          async run(prompt) {
            return prompt;
          },
        },
      });
      await manager.runSync(parent);
      const persisted = manager.listRuns()[0];
      assert.equal(persisted.currentPhase, "Parent");
      assert.equal(persisted.agents.at(-1)?.phase, "Parent");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("nested workflow phase restoration stays string-only and cannot mask a child failure", async () => {
  const child = `export const meta = { name: 'child-phase', description: 'child phase' }
phase('Child')
return await agent('child')`;
  const parentWithoutPhase = `export const meta = { name: 'no-parent-phase', description: 'no parent phase' }
await workflow('child')
return await agent('parent-after')`;
  const phases: string[] = [];
  const agentPhases: Array<string | undefined> = [];
  await runWorkflow(parentWithoutPhase, {
    persistLogs: false,
    loadSavedWorkflow: () => child,
    onPhase: (title) => phases.push(title),
    onAgentStart: (event) => agentPhases.push(event.phase),
    agent: {
      async run(prompt) {
        return prompt;
      },
    },
  });
  assert.deepEqual(phases, ["Child"], "restoring an absent parent phase must not invoke the public callback");
  assert.equal(agentPhases.at(-1), undefined);

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-no-parent-phase-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-no-parent-phase-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const manager = new WorkflowManager({
        cwd,
        loadSavedWorkflow: () => child,
        agent: {
          async run(prompt) {
            return prompt;
          },
        },
      });
      await manager.runSync(parentWithoutPhase);
      const persisted = manager.listRuns()[0];
      assert.equal(persisted.currentPhase, undefined, "manager state restores the absent parent phase internally");
      assert.equal(persisted.agents.at(-1)?.phase, undefined);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }

  const failingParent = `export const meta = { name: 'phase-mask', description: 'phase mask' }
phase('Parent')
return await workflow('child')`;
  let parentPhaseCalls = 0;
  await assert.rejects(
    () =>
      runWorkflow(failingParent, {
        persistLogs: false,
        loadSavedWorkflow: () => child,
        onPhase: (title) => {
          if (title === "Parent" && ++parentPhaseCalls > 1) throw new Error("restore callback failed");
        },
        agent: {
          async run() {
            throw new WorkflowError("original child failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
              recoverable: false,
            });
          },
        },
      }),
    (error: unknown) => error instanceof Error && /original child failure/.test(error.message),
    "a restoration callback failure must not replace the child failure",
  );
});

test("timed-out resource reload and session setup cannot overlap retries or persist late metadata", async () => {
  const target = { provider: "mock", id: "target", name: "Target" } as Model<unknown>;
  const reloadGate = deferred<void>();
  const reloadStarted = deferred<void>();
  let reloadCalls = 0;
  let reloadSessionCalls = 0;
  const reloadLoader = fakeLoader();
  reloadLoader.reload = async () => {
    reloadCalls++;
    reloadStarted.resolve();
    await reloadGate.promise;
  };
  const reloadAgent = new WorkflowAgent({
    cwd: "/tmp",
    modelRegistry: modelRegistry(target),
    resourceLoaderFactory: () => reloadLoader,
    sessionFactory: async () => {
      reloadSessionCalls++;
      throw new Error("a timed-out reload must never reach session creation");
    },
  });
  const reloadRun = runWorkflow(
    `export const meta = { name: 'reload-timeout', description: 'reload timeout' }
return await agent('work', { model: 'mock/target', timeoutMs: 5, retries: 1 })`,
    { agent: reloadAgent, modelRegistry: modelRegistry(target), persistLogs: false },
  );
  await reloadStarted.promise;
  assert.equal((await reloadRun).result, null);
  assert.equal(reloadCalls, 1, "a retry must not overlap an unsettled cancelled reload");
  reloadGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reloadSessionCalls, 0, "a late reload completion must honor the timeout before session creation");

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-session-setup-timeout-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-session-setup-timeout-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const sessionGate = deferred<never>();
      const sessionStarted = deferred<void>();
      let sessionCalls = 0;
      let metadataWrites = 0;
      let aborts = 0;
      let disposals = 0;
      let prompts = 0;
      const session = {
        model: target,
        thinkingLevel: "medium",
        systemPrompt: "",
        messages: [] as unknown[],
        prompt: async () => {
          prompts++;
        },
        abort: async () => {
          aborts++;
        },
        subscribe: () => () => {},
        getActiveToolNames: () => [],
        getSessionStats: () => ({
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }),
        dispose: () => {
          disposals++;
        },
      };
      const sessionAgent = new WorkflowAgent({
        cwd,
        persistAgentSessions: true,
        modelRegistry: modelRegistry(target),
        resourceLoaderFactory: () => fakeLoader(),
        sessionFactory: async (options: CreateAgentSessionOptions) => {
          sessionCalls++;
          if (options.sessionManager) {
            options.sessionManager.appendSessionInfo = () => {
              metadataWrites++;
            };
          }
          sessionStarted.resolve();
          await sessionGate.promise;
          return { session, extensionsResult: fakeLoader().getExtensions() } as never;
        },
      });
      const sessionRun = runWorkflow(
        `export const meta = { name: 'session-timeout', description: 'session timeout' }
return await agent('work', { model: 'mock/target', timeoutMs: 5, retries: 1 })`,
        { agent: sessionAgent, modelRegistry: modelRegistry(target), persistLogs: false },
      );
      await sessionStarted.promise;
      assert.equal((await sessionRun).result, null);
      assert.equal(sessionCalls, 1, "a retry must not overlap unsettled session creation");
      sessionGate.resolve(undefined as never);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(metadataWrites, 0, "late session creation must not persist identifying metadata");
      assert.equal(prompts, 0, "late session creation must not start provider work");
      assert.equal(aborts, 1, "a session created after cancellation is aborted immediately");
      assert.equal(disposals, 1, "a session created after cancellation is disposed immediately");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
