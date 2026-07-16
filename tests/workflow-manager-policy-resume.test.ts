import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const strictScript = `export const meta = { name: 'strict-resume', description: 'strict resume' }
return await agent('work', { agentType: 'missing' })`;

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
