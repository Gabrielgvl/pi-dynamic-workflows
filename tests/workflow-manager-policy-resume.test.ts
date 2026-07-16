import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const strictScript = `export const meta = { name: 'strict-resume', description: 'strict resume' }
return await agent('work', { agentType: 'missing' })`;

test("cold resume restores execution limits and counts already-consumed token budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-limits-resume-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-limits-resume-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      let firstCalls = 0;
      const firstManager = new WorkflowManager({
        cwd,
        concurrency: 8,
        defaultAgentRetries: 0,
        agent: {
          async run(_prompt: string, options: any) {
            firstCalls++;
            if (firstCalls === 1) {
              options.onUsage?.({ input: 3, output: 3, cacheRead: 0, cacheWrite: 0, total: 6, cost: 0 });
              return "first";
            }
            options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          },
        },
      });
      firstManager.on("error", () => {});
      await assert.rejects(() =>
        firstManager.runSync(
          `export const meta = { name: 'limit-resume', description: 'limits' }
await agent('first')
await agent('second')
return await agent('third')`,
          undefined,
          {
            maxAgents: 3,
            agentTimeoutMs: 1234,
            tokenBudget: 10,
            concurrency: 1,
            agentRetries: 2,
            agentTypePolicy: "error",
          },
        ),
      );
      const persisted = firstManager.listRuns().find((run) => run.workflowName === "limit-resume");
      assert.ok(persisted);
      assert.deepEqual(persisted.executionPolicy, {
        cwd,
        maxAgents: 3,
        agentTimeoutMs: 1234,
        tokenBudget: 10,
        concurrency: 1,
        agentRetries: 2,
        agentTypePolicy: "error",
      });
      assert.equal(persisted.tokenUsage?.total, 7);

      let resumedCalls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        concurrency: 9,
        defaultAgentRetries: 0,
        agent: {
          async run(_prompt: string, options: any) {
            resumedCalls++;
            options.onUsage?.({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0 });
            return "second";
          },
        },
      });
      const failed = new Promise<WorkflowError>((resolve) => {
        resumedManager.on("error", (event: { runId: string; error: WorkflowError }) => {
          if (event.runId === persisted.runId) resolve(event.error);
        });
      });
      assert.equal(await resumedManager.resume(persisted.runId), true);
      const error = await failed;
      assert.equal(error.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
      assert.equal(resumedCalls, 1, "the third agent is blocked by 7 persisted + 5 resumed tokens");
      assert.equal(resumedManager.getPersistence().load(persisted.runId)?.tokenUsage?.total, 12);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("per-run cwd is used for execution and restored by cold resume", async () => {
  const storageCwd = mkdtempSync(join(tmpdir(), "pi-dw-storage-cwd-"));
  const executionCwd = mkdtempSync(join(tmpdir(), "pi-dw-execution-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-cwd-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const prompts: string[] = [];
      const manager = new WorkflowManager({
        cwd: storageCwd,
        agent: {
          async run(prompt: string) {
            prompts.push(prompt);
            return "ok";
          },
        },
      });
      const script = `export const meta = { name: 'cwd-policy', description: 'cwd policy' }
return await agent(cwd)`;
      await manager.runSync(script, undefined, { cwd: executionCwd });
      assert.equal(prompts[0], executionCwd);
      const first = manager.listRuns()[0];
      manager.getPersistence().save({ ...first, status: "paused", agents: [], journal: [] });

      const coldPrompts: string[] = [];
      const cold = new WorkflowManager({
        cwd: storageCwd,
        agent: {
          async run(prompt: string) {
            coldPrompts.push(prompt);
            return "ok";
          },
        },
      });
      const completed = new Promise<void>((resolve) => {
        cold.on("complete", (event: { runId: string }) => event.runId === first.runId && resolve());
      });
      assert.equal(await cold.resume(first.runId), true);
      await completed;
      assert.equal(coldPrompts[0], executionCwd);
      assert.equal(cold.getPersistence().load(first.runId)?.cwd, executionCwd);
    });
  } finally {
    rmSync(storageCwd, { recursive: true, force: true });
    rmSync(executionCwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("relative execution cwd is canonicalized before persistence and survives cold resume from another process cwd", async () => {
  const storageCwd = mkdtempSync(join(tmpdir(), "pi-dw-canonical-storage-"));
  const firstProcessCwd = mkdtempSync(join(tmpdir(), "pi-dw-canonical-first-"));
  const secondProcessCwd = mkdtempSync(join(tmpdir(), "pi-dw-canonical-second-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-canonical-home-"));
  const originalProcessCwd = process.cwd();
  mkdirSync(join(firstProcessCwd, "project"));
  mkdirSync(join(secondProcessCwd, "project"));
  try {
    await withFakeHomeAsync(home, async () => {
      process.chdir(firstProcessCwd);
      const first = new WorkflowManager({
        cwd: storageCwd,
        agent: {
          async run() {
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          },
        },
      });
      const { runId, promise } = first.startInBackground(
        `export const meta = { name: 'canonical-cwd', description: 'canonical cwd' }
return await agent(cwd)`,
        undefined,
        { cwd: "project" },
      );
      await promise.catch(() => {});
      const canonical = realpathSync(join(firstProcessCwd, "project"));
      assert.equal(first.getPersistence().load(runId)?.executionPolicy?.cwd, canonical);

      process.chdir(secondProcessCwd);
      const prompts: string[] = [];
      const cold = new WorkflowManager({
        cwd: storageCwd,
        agent: {
          async run(prompt: string) {
            prompts.push(prompt);
            return "ok";
          },
        },
      });
      const completed = new Promise<void>((resolve) => {
        cold.on("complete", (event: { runId: string }) => event.runId === runId && resolve());
      });
      assert.equal(await cold.resume(runId), true);
      await completed;
      assert.deepEqual(prompts, [canonical]);
      assert.equal(cold.getPersistence().load(runId)?.cwd, canonical);
    });
  } finally {
    process.chdir(originalProcessCwd);
    rmSync(storageCwd, { recursive: true, force: true });
    rmSync(firstProcessCwd, { recursive: true, force: true });
    rmSync(secondProcessCwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("phase budgets retain consumed tokens through repeated multi-phase cold resumes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-phase-budget-resume-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-phase-budget-resume-home-"));
  const attempts = new Map<string, number>();
  const script = `export const meta = { name: 'phase-budget-resume', description: 'phase budgets' }
phase('A', { budget: 10 })
await agent('a')
await agent('a2')
let aBlocked = false
try { await agent('a3') } catch (error) { aBlocked = error.code === 'TOKEN_BUDGET_EXHAUSTED' }
phase('B', { budget: 10 })
await agent('b')
await agent('b2')
let bBlocked = false
try { await agent('b3') } catch (error) { bBlocked = error.code === 'TOKEN_BUDGET_EXHAUSTED' }
return { aBlocked, bBlocked }`;
  const makeManager = () =>
    new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options: any) {
          const count = (attempts.get(prompt) ?? 0) + 1;
          attempts.set(prompt, count);
          if ((prompt === "a2" || prompt === "b2") && count === 1) {
            options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          }
          const total = prompt === "a" ? 6 : prompt === "a2" || prompt === "b" ? 4 : 7;
          options.onUsage?.({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0 });
          return prompt;
        },
      },
    });
  try {
    await withFakeHomeAsync(home, async () => {
      const first = makeManager();
      const { runId, promise } = first.startInBackground(script);
      await promise.catch(() => {});
      assert.deepEqual(first.getPersistence().load(runId)?.phaseBudgets, {
        A: { budget: 10, spent: 7, warned: false },
      });

      const second = makeManager();
      assert.equal(await second.resume(runId), true);
      for (let i = 0; i < 100 && second.getRun(runId)?.status === "running"; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(second.getRun(runId)?.status, "paused");
      assert.deepEqual(second.getPersistence().load(runId)?.phaseBudgets, {
        A: { budget: 10, spent: 11, warned: false },
        B: { budget: 10, spent: 5, warned: false },
      });

      const third = makeManager();
      assert.equal(await third.resume(runId), true);
      for (let i = 0; i < 100 && third.getRun(runId)?.status === "running"; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(third.getRun(runId)?.status, "completed", third.getRun(runId)?.error?.message);
      assert.equal(
        JSON.stringify(third.getRun(runId)?.result?.result),
        JSON.stringify({ aBlocked: true, bBlocked: true }),
      );
      assert.deepEqual(third.getPersistence().load(runId)?.phaseBudgets, {
        A: { budget: 10, spent: 11, warned: false },
        B: { budget: 10, spent: 12, warned: false },
      });
      assert.equal(attempts.has("a3"), false);
      assert.equal(attempts.has("b3"), false);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy persisted runs reconstruct phase spend from agent snapshots", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-legacy-phase-budget-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-legacy-phase-budget-home-"));
  let secondCalls = 0;
  const script = `export const meta = { name: 'legacy-phase-budget', description: 'legacy phase budget' }
phase('Legacy', { budget: 10 })
await agent('first')
await agent('second')
let blocked = false
try { await agent('third') } catch (error) { blocked = error.code === 'TOKEN_BUDGET_EXHAUSTED' }
return { blocked }`;
  try {
    await withFakeHomeAsync(home, async () => {
      const first = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt: string, options: any) {
            if (prompt === "first") {
              options.onUsage?.({ input: 6, output: 0, cacheRead: 0, cacheWrite: 0, total: 6, cost: 0 });
              return "first";
            }
            options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
            throw new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          },
        },
      });
      const { runId, promise } = first.startInBackground(script);
      await promise.catch(() => {});
      const legacy = first.getPersistence().load(runId);
      assert.ok(legacy);
      delete legacy.phaseBudgets;
      first.getPersistence().save(legacy);

      let thirdCalls = 0;
      const cold = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt: string, options: any) {
            if (prompt === "second") {
              secondCalls++;
              options.onUsage?.({ input: 4, output: 0, cacheRead: 0, cacheWrite: 0, total: 4, cost: 0 });
              return "second";
            }
            thirdCalls++;
            return "unexpected";
          },
        },
      });
      const completed = new Promise<any>((resolve) => {
        cold.on("complete", (event: any) => event.runId === runId && resolve(event));
      });
      assert.equal(await cold.resume(runId), true);
      const outcome = await completed;
      assert.equal(JSON.stringify(outcome.result.result), JSON.stringify({ blocked: true }));
      assert.equal(secondCalls, 1);
      assert.equal(thirdCalls, 0);
      assert.equal(cold.getPersistence().load(runId)?.phaseBudgets?.Legacy.spent, 11);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a strict per-execution agentTypePolicy remains strict after cold resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-policy-resume-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-policy-resume-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const firstManager = new WorkflowManager({
        cwd,
        agentTypePolicy: "fallback",
        agent: {
          async run() {
            return "ok";
          },
        },
      });
      firstManager.on("error", () => {});
      await assert.rejects(
        () => firstManager.runSync(strictScript, undefined, { agentTypePolicy: "error" }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
          assert.equal(error.message, 'Unknown agentType "missing"');
          return true;
        },
      );

      const persisted = firstManager.listRuns().find((run) => run.workflowName === "strict-resume");
      assert.ok(persisted);
      assert.equal(
        (persisted as typeof persisted & { agentTypePolicy?: string }).agentTypePolicy,
        "error",
        "the effective execution policy is durable",
      );

      let calls = 0;
      const resumedManager = new WorkflowManager({
        cwd,
        agentTypePolicy: "fallback",
        agent: {
          async run() {
            calls++;
            return "must-not-run";
          },
        },
      });
      const outcome = new Promise<{ type: "complete" | "error"; error?: WorkflowError }>((resolve) => {
        resumedManager.on("complete", (event: { runId: string }) => {
          if (event.runId === persisted.runId) resolve({ type: "complete" });
        });
        resumedManager.on("error", (event: { runId: string; error: WorkflowError }) => {
          if (event.runId === persisted.runId) resolve({ type: "error", error: event.error });
        });
      });

      assert.equal(await resumedManager.resume(persisted.runId), true);
      const resumed = await outcome;
      assert.equal(resumed.type, "error");
      assert.equal(resumed.error?.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(resumed.error?.message, 'Unknown agentType "missing"');
      assert.equal(calls, 0, "resume must not fall back to the new manager's permissive policy");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
