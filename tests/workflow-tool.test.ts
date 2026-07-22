import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager, WorkflowManagerRegistry } from "../src/workflow-manager.js";
import {
  backgroundStartedText,
  createWorkflowTool,
  modelRoutingGuideline,
  readWorkflowScriptPath,
  WORKFLOW_SCRIPT_MAX_BYTES,
} from "../src/workflow-tool.js";
import type { Worktree, WorktreeCleanupFailure } from "../src/worktree.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Minimal fake ModelRegistry, matching the shape the PR's existing tests use. */
function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  } as any;
}

// ─── backgroundStartedText ─────────────────────────────────────────────────────

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});

// ─── createWorkflowTool ────────────────────────────────────────────────────────

test("createWorkflowTool has correct name and label", () => {
  const tool = createWorkflowTool();
  assert.equal(tool.name, "workflow");
  assert.equal(tool.label, "Workflow");
});

test("createWorkflowTool has description", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.description.length > 20, "tool.description should be more than 20");
});

test("createWorkflowTool has parameters defined", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.parameters, "should have parameters schema");
});

test("createWorkflowTool has execute function", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWorkflowTool has renderCall and renderResult", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("createWorkflowTool has promptSnippet", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.promptSnippet.includes("workflow"), "should contain workflow");
});

test("createWorkflowTool has promptGuidelines array", () => {
  const tool = createWorkflowTool();
  assert.ok(Array.isArray(tool.promptGuidelines), "tool.promptGuidelines should be an array");
  assert.ok(tool.promptGuidelines.length > 5, "should have several guidelines");
});

test("createWorkflowTool documents the complete retained-worktree authoring contract", () => {
  const all = createWorkflowTool().promptGuidelines.join(" ");

  assert.match(all, /retainWorktree:\s*true/);
  assert.match(all, /\{\s*result\s*,\s*worktree\s*\}/);
  assert.match(all, /worktree:\s*handle/);
  assert.match(all, /releaseWorktree\(handle\)/);
  assert.match(all, /mandatory/i);
  assert.match(all, /idempotent/i);
  assert.match(all, /root.*terminal.*cleanup/i);
  assert.match(all, /opaque|do not.*path|avoid.*path/i);
});

test("createWorkflowTool routes normal work through tiers and reserves exact models for user requests", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");

  assert.match(all, /opts\.tier/);
  assert.match(all, /small.+medium.+big/s);
  assert.match(all, /opts\.model only when the user names/i);
});

test("createWorkflowTool promptGuidelines keep budget and timeout unbounded by default", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");
  assert.match(all, /do not set tokenBudget or agentTimeoutMs/i);
  assert.match(all, /defaults are unbounded/i);
});

test("createWorkflowTool schema describes unbounded default timeout", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };
  const description = parameters.properties?.agentTimeoutMs?.description ?? "";
  assert.match(description, /Omit for no hard timeout/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema exposes concurrency and agentRetries", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };

  assert.match(parameters.properties?.concurrency?.description ?? "", /Maximum concurrent agents/i);
  assert.match(parameters.properties?.agentRetries?.description ?? "", /Retry attempts/i);
});

test("createWorkflowTool promptGuidelines mention retry and concurrency controls", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");

  assert.match(all, /low concurrency/i);
  assert.match(all, /agentRetries/i);
  assert.match(all, /null handling/i);
});

// ─── modelRoutingGuideline ──────────────────────────────────────────────────────

test("modelRoutingGuideline mentions all three tier names", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("small"), "should mention small tier");
  assert.ok(text.includes("medium"), "should mention medium tier");
  assert.ok(text.includes("big"), "should mention big tier");
});

test("modelRoutingGuideline describes each tier purpose", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("lightweight"), "should contain lightweight");
  assert.ok(text.includes("balanced"), "should contain balanced");
  assert.ok(text.includes("synthesis"), "should contain synthesis");
});

test("modelRoutingGuideline explains tier vs model priority", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.includes("opts.tier"), "should mention opts.tier");
  assert.ok(text.includes("opts.model"), "should mention opts.model");
  assert.ok(
    /opts\.(tier|model).+opts\.(model|tier)/.test(text),
    "should explain ordering / relationship between tier and model",
  );
});

test("modelRoutingGuideline explains when to use each option", () => {
  const text = modelRoutingGuideline();
  assert.ok(/small.*(exploration|search|inventory|agents)/i.test(text), "small tier should mention light workloads");
  assert.ok(/big.*(synthesis|judgment|decision)/i.test(text), "big tier should mention heavy reasoning");
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  // We can test prepareArguments through the tool definition
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    assert.throws(() => prepare({ script: 123 }), /script.*string/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "workflow");
});

test("createWorkflowTool does not add configured model IDs to promptGuidelines", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "private-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });

  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/private-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "later-private-model" }]));
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/later-private-model/);
});

test("modelRoutingGuideline output is non-empty and well-formed", () => {
  const text = modelRoutingGuideline();
  assert.ok(text.length > 50, "should be a substantial instruction");
  assert.ok(text.endsWith(".") || text.endsWith("") || text.endsWith("`"), "should end properly");
  assert.ok(!text.includes("undefined"), "no undefined interpolation");
  assert.ok(!text.includes("[object Object]"), "no object serialization leaks");
});

// ─── prepareArguments / normalizeWorkflowScript ─────────────────────────────────

test("createWorkflowTool prepareArguments strips markdown fences from script", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```js\nconst x = 1\n```",
    });
    assert.equal(result.script, "const x = 1");
  }
});

test("createWorkflowTool prepareArguments strips javascript fences", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```\nexport const meta = { name: 't', description: 't' }\n```",
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
  }
});

test("createWorkflowTool exposes both optional run source fields in the schema", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as {
    properties?: Record<string, { anyOf?: unknown[]; description?: string }>;
    required?: string[];
  };

  assert.ok(parameters.properties?.action);
  assert.ok(parameters.properties?.cwd);
  assert.ok(parameters.properties?.runId);
  assert.ok(parameters.properties?.script);
  assert.ok(parameters.properties?.scriptPath);
  assert.equal(parameters.required?.includes("script") ?? false, false);
  assert.equal(parameters.required?.includes("scriptPath") ?? false, false);
  assert.match(parameters.properties?.script?.description ?? "", /exactly one.*script.*scriptPath/i);
  assert.match(parameters.properties?.scriptPath?.description ?? "", /canonical.*cwd/i);
  assert.match(parameters.properties?.scriptPath?.description ?? "", /freshly read|each invocation/i);
  assert.match(parameters.properties?.scriptPath?.description ?? "", /1 MiB|1048576 bytes/i);
  assert.match(parameters.properties?.scriptPath?.description ?? "", /final symlinks?.*followed/i);
});

test("createWorkflowTool guidance explains script and scriptPath source selection", () => {
  const tool = createWorkflowTool();
  assert.match(tool.description, /scriptPath/);
  assert.match(tool.promptSnippet ?? "", /scriptPath/);
  assert.match(tool.promptGuidelines.join(" "), /exactly one.*script.*scriptPath/i);
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };
  assert.match(parameters.properties?.resumeFromRunId?.description ?? "", /scriptPath/);
});

test("createWorkflowTool prepareArguments keeps omitted action as a legacy run", () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as (args: unknown) => { action?: string; script: string };
  const result = prepare({ script: " const x = 1 " });

  assert.equal(result.action, undefined);
  assert.equal(result.script, "const x = 1");
});

test("createWorkflowTool prepareArguments requires exactly one run source by property presence", () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as (args: unknown) => { script?: string; scriptPath?: string };

  assert.deepEqual(prepare({ script: " return 1 " }), { script: "return 1" });
  assert.deepEqual(prepare({ scriptPath: " workflows/a.js " }), { scriptPath: "workflows/a.js" });
  assert.deepEqual(prepare({ script: "" }), { script: "" }, "an empty inline script is still a present source");
  assert.throws(() => prepare({ action: "run" }), /exactly one.*script.*scriptPath/i);
  assert.throws(() => prepare({ script: "return 1", scriptPath: "workflow.js" }), /exactly one.*script.*scriptPath/i);
  assert.throws(() => prepare({ script: undefined, scriptPath: "workflow.js" }), /exactly one.*script.*scriptPath/i);
  assert.throws(() => prepare({ scriptPath: "   " }), /scriptPath.*non-empty/i);
  assert.throws(() => prepare({ scriptPath: 123 }), /scriptPath.*string/i);
  assert.throws(() => prepare({ script: undefined }), /script.*string/i);
});

test("createWorkflowTool prepareArguments validates action-specific field combinations strictly", () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as (args: unknown) => unknown;

  assert.throws(() => prepare({ action: "status", script: "return 1" }), /status.*script/i);
  assert.throws(() => prepare({ action: "status", scriptPath: "workflow.js" }), /status.*scriptPath/i);
  assert.throws(() => prepare({ action: "status", background: true }), /status.*background/i);
  assert.throws(() => prepare({ action: "resume" }), /resume.*runId/i);
  assert.throws(() => prepare({ action: "resume", runId: "r1", args: {} }), /resume.*args/i);
  assert.throws(() => prepare({ action: "resume", runId: "r1", scriptPath: "workflow.js" }), /resume.*scriptPath/i);
  assert.throws(() => prepare({ action: "resume", runId: "r1", resumeFromRunId: "r0" }), /resume.*resumeFromRunId/i);
  assert.throws(() => prepare({ action: "stop" }), /stop.*runId/i);
  assert.throws(() => prepare({ action: "stop", runId: "r1", scriptPath: "workflow.js" }), /stop.*scriptPath/i);
  assert.throws(() => prepare({ action: "stop", runId: "r1", tokenBudget: 10 }), /stop.*tokenBudget/i);
  assert.throws(() => prepare({ action: "invalid", runId: "r1" }), /action/i);
  assert.throws(() => prepare({ action: "status", runId: "../other-project" }), /path-safe/i);
  assert.throws(() => prepare({ script: "return 1", runId: "r1" }), /runId/i);
  assert.throws(() => prepare({ script: "return 1", resumeFromRunId: "../other-project" }), /path-safe/i);
});

test("createWorkflowTool canonicalizes an explicit cwd during argument preparation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-cwd-"));
  const link = `${cwd}-link`;
  try {
    symlinkSync(cwd, link, process.platform === "win32" ? "junction" : "dir");
    const tool = createWorkflowTool({ cwd });
    const prepare = tool.prepareArguments as (args: unknown) => { action: string; cwd: string; runId: string };
    const result = prepare({ action: "status", cwd: link, runId: "r1" });
    assert.equal(result.cwd, cwd);
  } finally {
    rmSync(link, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(
  "foreground workflow completion warns about bounded path-free cleanup failures without masking success",
  withToolTempCwd(async (cwd) => {
    const posixSecret = join(cwd, "foreground-private-fragment", "checkout");
    const windowsSecret = "C:\\Users\\foreground-private-fragment\\checkout";
    const hostileLabel = `${posixSecret}\ncontrol\u0001 ${windowsSecret} api-key=tool-label-secret`;
    const worktree: Worktree = {
      isolated: true,
      cwd: posixSecret,
      repoRoot: cwd,
      branch: "pi/wf/foreground-warning",
      branchRef: "refs/heads/pi/wf/foreground-warning",
      baseSha: "a".repeat(40),
    };
    const manager = new WorkflowManager({
      cwd,
      agent: toolFakeAgent("computed result"),
      worktreeOperations: {
        async createWorktree() {
          return worktree;
        },
        async removeWorktree(): Promise<WorktreeCleanupFailure[]> {
          return [
            {
              stage: "worktree_remove",
              message: `cannot remove ${posixSecret} or ${windowsSecret}`,
              identity: {
                repoRoot: cwd,
                worktreePath: posixSecret,
                branchRef: worktree.branchRef ?? "",
                baseSha: worktree.baseSha ?? "",
              },
            },
          ];
        },
      },
    });
    const tool = createWorkflowTool({ cwd, manager });
    const result = await tool.execute(
      "foreground-cleanup-warning",
      {
        script: `export const meta = { name: 'foreground_warning', description: 'cleanup warning' }
await agent('producer', { label: ${JSON.stringify(hostileLabel)}, isolation: 'worktree' })
return 'computed result'`,
        background: false,
      },
      undefined,
      () => {},
      {},
    );
    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    const failures = result.details.worktreeCleanupFailures as WorktreeCleanupFailure[];
    assert.equal(result.details.result, "computed result");
    assert.ok(failures.length > 0);
    assert.match(text, /warning/i);
    assert.match(text, /worktree_remove/);
    assert.match(text, new RegExp(`${failures.length}.*cleanup`, "i"));
    const publicSurface = JSON.stringify({ text, failures, logs: result.details.logs });
    for (const secret of [
      posixSecret,
      windowsSecret,
      "foreground-private-fragment",
      "Users",
      "control",
      "api-key",
      "tool-label-secret",
    ]) {
      assert.equal(publicSurface.includes(secret), false, `foreground cleanup tool details omit ${secret}`);
    }

    const cleanManager = new WorkflowManager({
      cwd,
      agent: toolFakeAgent("clean result"),
      worktreeOperations: {
        async createWorktree() {
          return {
            ...worktree,
            cwd: join(cwd, "clean-checkout"),
            branch: "pi/wf/clean",
            branchRef: "refs/heads/pi/wf/clean",
          };
        },
        async removeWorktree() {
          return [];
        },
      },
    });
    const clean = await createWorkflowTool({ cwd, manager: cleanManager }).execute(
      "foreground-clean-control",
      {
        script: `export const meta = { name: 'foreground_clean', description: 'clean completion' }
await agent('producer', { isolation: 'worktree', retainWorktree: true })
return 'clean result'`,
        background: false,
      },
      undefined,
      () => {},
      {},
    );
    const cleanText = clean.content?.[0]?.type === "text" ? clean.content[0].text : "";
    assert.doesNotMatch(cleanText, /cleanup warning/i);
    assert.equal(clean.details.worktreeCleanupFailures, undefined);
  }),
);

test("createWorkflowTool routes run/status/resume/stop through the canonical cwd manager", async () => {
  const first = mkdtempSync(join(tmpdir(), "pi-dw-tool-first-"));
  const second = mkdtempSync(join(tmpdir(), "pi-dw-tool-second-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tool-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = new WorkflowManagerRegistry({
        createManager(cwd) {
          return new WorkflowManager({
            cwd,
            agent: {
              async run() {
                return "ok";
              },
            },
          });
        },
      });
      const tool = createWorkflowTool({ cwd: first, managerRegistry: registry });
      const execute = tool.execute as (...args: any[]) => Promise<any>;
      const runResult = await execute(
        "call-run",
        {
          action: "run",
          cwd: second,
          script: `export const meta = { name: 'tool_actions', description: 'tool actions' }
const value = await agent('work', { label: 'worker' })
return { value, cwd }`,
          background: false,
        },
        undefined,
        () => {},
        {},
      );
      const runId = runResult.details.runId as string;
      assert.equal(runResult.details.result.cwd, second);
      assert.equal(registry.get(first).listAllRuns().length, 0, "default cwd namespace remains untouched");

      const statusResult = await execute(
        "call-status",
        { action: "status", cwd: second, runId },
        undefined,
        () => {},
        {},
      );
      assert.equal(statusResult.details.run.runId, runId);
      assert.equal(statusResult.details.run.cwd, second);
      assert.equal("script" in statusResult.details.run, false);
      assert.equal("args" in statusResult.details.run, false);

      registry.get(first).getPersistence().save({
        runId: "foreign-namespace",
        workflowName: "foreign",
        script: "secret foreign script",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const listResult = await execute("call-status-list", { action: "status", cwd: second }, undefined, () => {}, {});
      assert.ok(listResult.details.runs.length <= 20);
      assert.equal(
        listResult.details.runs.some((run: { runId: string }) => run.runId === "foreign-namespace"),
        false,
        "status never scans another cwd namespace",
      );

      const pausedId = "tool-paused";
      registry
        .get(second)
        .getPersistence()
        .save({
          runId: pausedId,
          workflowName: "tool_actions",
          script: `export const meta = { name: 'tool_actions', description: 'tool actions' }
return await agent('work', { label: 'worker' })`,
          status: "paused",
          phases: [],
          agents: [],
          logs: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      const resumeResult = await execute(
        "call-resume",
        { action: "resume", cwd: second, runId: pausedId },
        undefined,
        () => {},
        {},
      );
      assert.equal(resumeResult.details.resumed, true);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const stopId = "tool-stop";
      registry.get(second).getPersistence().save({
        runId: stopId,
        workflowName: "tool_actions",
        script: "",
        status: "paused",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const stopResult = await execute(
        "call-stop",
        { action: "stop", cwd: second, runId: stopId },
        undefined,
        () => {},
        {},
      );
      assert.equal(stopResult.details.stopped, true);
      assert.equal(registry.get(second).getPersistence().load(stopId)?.status, "aborted");
    });
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "workflow tool: scriptPath resolves from canonical selected cwd with foreground/background parity and fresh reads",
  withToolTempCwd(async (cwd) => {
    const link = `${cwd}-link`;
    const scriptPath = join(cwd, "workflow.js");
    symlinkSync(cwd, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
      const registry = new WorkflowManagerRegistry({ defaultCwd: cwd, defaultManager: manager });
      const tool = createWorkflowTool({ cwd, managerRegistry: registry });
      const source = (marker: string) => `export const meta = { name: 'path_run', description: 'path run' }
const value = await agent('${marker}', { label: 'worker' })
return { value, marker: '${marker}', cwd }`;

      writeFileSync(scriptPath, source("FIRST"));
      const foreground = await tool.execute(
        "path-foreground",
        { cwd: link, scriptPath: "workflow.js", background: false },
        undefined,
        () => {},
        {},
      );
      assert.equal(foreground.details.cwd, cwd);
      assert.equal(foreground.details.result.value, "ok");
      assert.equal(foreground.details.result.marker, "FIRST");
      assert.equal(foreground.details.result.cwd, cwd);

      writeFileSync(scriptPath, source("SECOND"));
      const background = await tool.execute(
        "path-background",
        { cwd: link, scriptPath: "workflow.js" },
        undefined,
        () => {},
        {},
      );
      const runId = background.details.runId as string;
      for (let attempt = 0; attempt < 50 && manager.getRun(runId)?.status === "running"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const completed = manager.getRun(runId);
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.result?.result?.value, "ok");
      assert.equal(completed?.result?.result?.marker, "SECOND");
      assert.equal(completed?.result?.result?.cwd, cwd);
    } finally {
      rmSync(link, { force: true });
    }
  }),
);

test(
  "workflow tool: scriptPath reports actionable host filesystem errors",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });

    await assert.rejects(
      () => tool.execute("missing", { scriptPath: "missing.js" }, undefined, undefined, undefined),
      /scriptPath.*missing\.js.*not found.*resolved/i,
    );
    await assert.rejects(
      () => tool.execute("directory", { scriptPath: "." }, undefined, undefined, undefined),
      /scriptPath.*directory.*regular file/i,
    );

    if (process.platform !== "win32") {
      const unreadable = join(cwd, "unreadable.js");
      writeFileSync(unreadable, resumeToolScript);
      chmodSync(unreadable, 0);
      if (typeof process.getuid !== "function" || process.getuid() !== 0) {
        await assert.rejects(
          () => tool.execute("unreadable", { scriptPath: "unreadable.js" }, undefined, undefined, undefined),
          /scriptPath.*unreadable\.js.*not readable|permission denied/i,
        );
      }
      chmodSync(unreadable, 0o600);
    }

    if (process.platform !== "win32") {
      const fifo = join(cwd, "workflow.fifo");
      execFileSync("mkfifo", [fifo]);
      await assert.rejects(
        () => tool.execute("non-regular", { scriptPath: "workflow.fifo" }, undefined, undefined, undefined),
        /scriptPath.*workflow\.fifo.*not a regular file.*fifo/i,
      );
    }
  }),
);

test(
  "workflow tool: scriptPath accepts the exact source byte limit and rejects limit plus one",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    const scriptPath = join(cwd, "bounded-workflow.js");
    const source = `export const meta = { name: 'bounded_path', description: 'bounded path' }
return await agent('work', { label: 'worker' })`;
    const paddingBytes = WORKFLOW_SCRIPT_MAX_BYTES - Buffer.byteLength(source);
    assert.ok(paddingBytes > 0);

    writeFileSync(scriptPath, `${source}${" ".repeat(paddingBytes)}`);
    const exact = await tool.execute(
      "exact-limit",
      { scriptPath: "bounded-workflow.js", background: false },
      undefined,
      () => {},
      {},
    );
    assert.equal(exact.details.result, "ok");

    appendFileSync(scriptPath, " ");
    await assert.rejects(
      () => tool.execute("over-limit", { scriptPath: "bounded-workflow.js" }, undefined, undefined, undefined),
      /scriptPath.*exceeds.*1 MiB.*1048576 bytes/i,
    );
  }),
);

test(
  "readWorkflowScriptPath opens once with readonly nonblocking flags where supported",
  withToolTempCwd(async (cwd) => {
    const scriptPath = join(cwd, "flags-workflow.js");
    writeFileSync(scriptPath, "ORIGINAL");
    let opened = 0;
    let closed = 0;

    const source = readWorkflowScriptPath("flags-workflow.js", cwd, {
      openSync(path, flags) {
        opened++;
        const nonblocking = (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
        assert.equal(path, scriptPath);
        assert.equal(flags, fsConstants.O_RDONLY | nonblocking);
        return openSync(path, fsConstants.O_RDONLY);
      },
      fstatSync,
      readSync,
      closeSync(fd) {
        closed++;
        closeSync(fd);
      },
    });

    assert.equal(source, "ORIGINAL");
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  }),
);

test(
  "readWorkflowScriptPath rejects a regular file that grows beyond the limit between read iterations and closes it",
  { skip: process.platform === "win32" },
  withToolTempCwd(async (cwd) => {
    const scriptPath = join(cwd, "growing-workflow.js");
    writeFileSync(scriptPath, Buffer.alloc(WORKFLOW_SCRIPT_MAX_BYTES, 0x20));
    let opened = 0;
    let closed = 0;
    let reads = 0;

    assert.throws(
      () =>
        readWorkflowScriptPath("growing-workflow.js", cwd, {
          openSync(path, flags) {
            opened++;
            return openSync(path, flags);
          },
          fstatSync,
          readSync(fd, buffer, offset, length, position) {
            reads++;
            const count = readSync(fd, buffer, offset, Math.min(length, 4096), position);
            if (reads === 1) appendFileSync(scriptPath, "x");
            return count;
          },
          closeSync(fd) {
            closed++;
            closeSync(fd);
          },
        }),
      /scriptPath.*exceeds.*1 MiB.*1048576 bytes/i,
    );
    assert.ok(reads >= 2, "the append must occur between loader read iterations");
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  }),
);

test("readWorkflowScriptPath maps injected permission errors without platform-specific chmod", () => {
  for (const code of ["EACCES", "EPERM"]) {
    assert.throws(
      () =>
        readWorkflowScriptPath("unreadable.js", "/workflows", {
          openSync() {
            throw Object.assign(new Error(code), { code });
          },
          fstatSync,
          readSync,
          closeSync,
        }),
      /scriptPath.*unreadable\.js.*not readable.*permission denied/i,
    );
  }
});

test(
  "readWorkflowScriptPath rejects truncation after fstat and closes the descriptor",
  { skip: process.platform === "win32" },
  withToolTempCwd(async (cwd) => {
    const scriptPath = join(cwd, "truncated-workflow.js");
    const retainedSource = `export const meta = { name: 'truncated_path', description: 'truncated path' }
return 'still-valid'`;
    writeFileSync(scriptPath, `${retainedSource}\n// removed after fstat`);
    let closed = 0;

    assert.throws(
      () =>
        readWorkflowScriptPath("truncated-workflow.js", cwd, {
          openSync,
          fstatSync(fd) {
            const stats = fstatSync(fd);
            truncateSync(scriptPath, Buffer.byteLength(retainedSource));
            return stats;
          },
          readSync,
          closeSync(fd) {
            closed++;
            closeSync(fd);
          },
        }),
      /scriptPath.*changed while reading.*retry/i,
    );
    assert.equal(closed, 1);
  }),
);

test(
  "readWorkflowScriptPath rejects growth after EOF before final descriptor validation",
  { skip: process.platform === "win32" },
  withToolTempCwd(async (cwd) => {
    const scriptPath = join(cwd, "post-eof-growth-workflow.js");
    writeFileSync(scriptPath, "ORIGINAL");
    let inspections = 0;
    let closed = 0;

    assert.throws(
      () =>
        readWorkflowScriptPath("post-eof-growth-workflow.js", cwd, {
          openSync,
          fstatSync(fd) {
            inspections++;
            if (inspections === 2) appendFileSync(scriptPath, "-CHANGED");
            return fstatSync(fd);
          },
          readSync,
          closeSync(fd) {
            closed++;
            closeSync(fd);
          },
        }),
      /scriptPath.*changed while reading.*retry/i,
    );
    assert.equal(inspections, 2);
    assert.equal(closed, 1);
  }),
);

test(
  "readWorkflowScriptPath keeps reading the opened object when the pathname is replaced",
  { skip: process.platform === "win32" },
  withToolTempCwd(async (cwd) => {
    const scriptPath = join(cwd, "replaceable-workflow.js");
    const replacementPath = join(cwd, "replacement-workflow.js");
    writeFileSync(scriptPath, "ORIGINAL");
    writeFileSync(replacementPath, "REPLACEMENT");
    let opened = 0;

    const source = readWorkflowScriptPath("replaceable-workflow.js", cwd, {
      openSync(path, flags) {
        opened++;
        const fd = openSync(path, flags);
        renameSync(replacementPath, scriptPath);
        return fd;
      },
      fstatSync,
      readSync,
      closeSync,
    });

    assert.equal(source, "ORIGINAL");
    assert.equal(opened, 1);
  }),
);

test(
  "workflow tool: scriptPath follows a final symlink to a regular file",
  { skip: process.platform === "win32" },
  withToolTempCwd(async (cwd) => {
    const targetPath = join(cwd, "target-workflow.js");
    const linkPath = join(cwd, "linked-workflow.js");
    writeFileSync(
      targetPath,
      `export const meta = { name: 'symlink_path', description: 'symlink path' }
return await agent('linked', { label: 'worker' })`,
    );
    symlinkSync(targetPath, linkPath);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("linked-ok") });
    const tool = createWorkflowTool({ cwd, manager });

    const result = await tool.execute(
      "final-symlink",
      { scriptPath: "linked-workflow.js", background: false },
      undefined,
      () => {},
      {},
    );
    assert.equal(result.details.result, "linked-ok");
  }),
);

test("createWorkflowTool prepareArguments passes through args", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => {
      script: string;
      args?: unknown;
      maxAgents?: number;
      concurrency?: number;
      agentRetries?: number;
    };
    const result = prepare({
      script: "export const meta = { name: 't', description: 't' }",
      args: { question: "test" },
      maxAgents: 5,
      concurrency: 2,
      agentRetries: 1,
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
    assert.deepEqual(result.args, { question: "test" });
    assert.equal(result.maxAgents, 5);
    assert.equal(result.concurrency, 2);
    assert.equal(result.agentRetries, 1);
  }
});

// ─── resumeFromRunId (edited-script iteration) ─────────────────────────────────

const resumeToolScript = `export const meta = { name: 'resume_tool', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function toolFakeAgent(result: unknown = "ok") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return result;
    },
  };
}

function deferredToolAgent() {
  let resolveFn: ((v: unknown) => void) | null = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    resolve: (v: unknown = "done") => resolveFn?.(v),
    runner: {
      async run() {
        return promise;
      },
    },
  };
}

function withToolTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-tool-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test("workflowToolSchema exposes resumeFromRunId while control actions keep script optional", () => {
  const tool = createWorkflowTool();
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.resumeFromRunId, "resumeFromRunId should be a schema property");
  assert.ok(!(schema.required ?? []).includes("script"), "control actions do not require script at schema level");
  assert.ok(!(schema.required ?? []).includes("resumeFromRunId"), "resumeFromRunId is optional");
});

test(
  "workflow tool: resumeFromRunId pointing at a nonexistent run errors and creates no new run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "t1",
          { script: resumeToolScript, resumeFromRunId: "no-such-run" },
          undefined,
          undefined,
          undefined,
        ),
      /no run with that ID|not found/i,
    );
    assert.equal(manager.listRuns().length, 0, "no new run should be created on a failed resume");
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a completed run errors clearly",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    // Create + complete a run.
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    await assert.rejects(
      () => tool.execute("t2", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, undefined),
      /already completed/i,
    );
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a running run errors clearly",
  withToolTempCwd(async (cwd) => {
    const da = deferredToolAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.getRun(runId)?.status, "running");
    await assert.rejects(
      () => tool.execute("t3", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, undefined),
      /still running/i,
    );
    da.resolve("ok");
    await promise.catch(() => {});
  }),
);

test(
  "workflow tool: omitting resumeFromRunId preserves new-run background behavior",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute("t4", { script: resumeToolScript }, undefined, undefined, undefined);
    const details = res.details as { runId?: string; background?: boolean; resumedFrom?: string };
    assert.ok(details.runId, "a new run id should be returned");
    assert.equal(details.background, true);
    assert.equal(details.resumedFrom, undefined, "a fresh run is not a resume");
    assert.equal(manager.listRuns().length, 1, "exactly one new run created");
    // The returned text advertises the revise/iterate path.
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, /resumeFromRunId/, "background text tells the model how to iterate");
  }),
);

test(
  "workflow tool: resumeFromRunId accepts scriptPath as the freshly read edited source",
  withToolTempCwd(async (cwd) => {
    const seen: string[] = [];
    let failSecond = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          seen.push(prompt);
          if (prompt.includes("SECOND-ORIG") && failSecond) {
            throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
              recoverable: false,
              resetHint: "soon",
            });
          }
          return `ran:${prompt}`;
        },
      },
    });
    manager.on("paused", () => {});
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    const v1 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-ORIG', { label: 'second' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(v1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    failSecond = false;
    const v2 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-EDITED', { label: 'second' })
return { a, b }`;
    const editedPath = join(cwd, "edited-workflow.js");
    writeFileSync(editedPath, v2);
    const seenBefore = seen.length;
    const res = await tool.execute(
      "t5",
      { scriptPath: "edited-workflow.js", resumeFromRunId: runId },
      undefined,
      undefined,
      undefined,
    );
    const details = res.details as { runId?: string; resumedFrom?: string };
    assert.equal(details.runId, runId, "resumed run keeps the same run id");
    assert.equal(details.resumedFrom, runId);
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, new RegExp(`resumed from run ${runId}`), "text names the resumed run");

    await new Promise((r) => setTimeout(r, 80));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(finalRun?.result?.result?.b, "ran:SECOND-EDITED");
    const during = seen.slice(seenBefore);
    assert.ok(!during.includes("FIRST"), "unchanged agent 1 replays from journal");
    assert.ok(during.includes("SECOND-EDITED"), "edited agent 2 re-runs live");
    // No extra run created — resume reuses the same id.
    assert.equal(manager.listRuns().length, 1, "resume does not create a second run");
  }),
);
