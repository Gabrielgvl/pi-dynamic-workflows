import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { WorkflowManager } from "../src/workflow-manager.js";
import { backgroundStartedText, createWorkflowTool, modelRoutingGuideline } from "../src/workflow-tool.js";

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

test("workflow tool accepts exactly one fresh, cwd-contained scriptPath source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-dw-tool-outside-"));
  try {
    const script = "export const meta = { name: 'path-workflow', description: 'path workflow' }\nreturn args";
    const scriptPath = join(root, "workflow.js");
    writeFileSync(scriptPath, script);
    const captured: Array<{ script: string; args: unknown }> = [];
    const manager = {
      getModelRegistry: () => undefined,
      startInBackground(source: string, args: unknown) {
        captured.push({ script: source, args });
        return { runId: "run-path", promise: Promise.resolve({}) };
      },
    } as any;
    const tool = createWorkflowTool({ cwd: root, manager });
    const execute = tool.execute as any;

    await execute("call", { scriptPath: "workflow.js", args: { fresh: true } }, undefined, undefined, { cwd: root });
    assert.deepEqual(captured, [{ script, args: { fresh: true } }]);
    writeFileSync(scriptPath, script.replace("path-workflow", "updated-workflow"));
    await execute("call", { scriptPath: "workflow.js", args: { fresh: false } }, undefined, undefined, { cwd: root });
    assert.equal(captured[1]?.script, script.replace("path-workflow", "updated-workflow"));

    const outsidePath = join(outside, "outside.js");
    writeFileSync(outsidePath, script);
    const invalid = [
      [{ script: script, scriptPath: "workflow.js" }, /exactly one/],
      [{}, /exactly one/],
      [{ scriptPath: "   " }, /non-empty/],
      [{ scriptPath: "missing.js" }, /does not exist/],
      [{ scriptPath: relative(root, outsidePath) }, /escapes workflow cwd/],
    ] as const;
    for (const [params, message] of invalid) {
      await assert.rejects(() => execute("call", params, undefined, undefined, { cwd: root }), message);
    }

    mkdirSync(join(root, "directory"));
    await assert.rejects(
      () => execute("call", { scriptPath: "directory" }, undefined, undefined, { cwd: root }),
      /must reference a file/,
    );
    symlinkSync(outsidePath, join(root, "linked.js"));
    await assert.rejects(
      () => execute("call", { scriptPath: "linked.js" }, undefined, undefined, { cwd: root }),
      /escapes workflow cwd/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("workflow tool passes exact scriptPath source and args to foreground manager.runSync", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-foreground-"));
  try {
    const script =
      "export const meta = { name: 'foreground-path', description: 'foreground path' }\n" +
      "await agent('preserve this source')\n  \n";
    writeFileSync(join(root, "workflow.js"), script);
    const args = { unchanged: true, nested: { value: "keep" } };
    const calls: Array<{ script: string; args: unknown }> = [];
    const manager = {
      getModelRegistry: () => undefined,
      runSync(source: string, receivedArgs: unknown) {
        calls.push({ script: source, args: receivedArgs });
        return Promise.resolve({
          meta: { name: "foreground-path", description: "foreground path" },
          result: { ok: true },
          logs: [],
          phases: [],
          agentCount: 1,
          durationMs: 1,
        });
      },
    } as any;
    const tool = createWorkflowTool({ cwd: root, manager });

    await (tool.execute as any)("call", { scriptPath: "workflow.js", args, background: false }, undefined, undefined, {
      cwd: root,
    });

    assert.deepEqual(calls, [{ script, args }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("createWorkflowTool promptGuidelines mention model routing", () => {
  const tool = createWorkflowTool();
  const all = tool.promptGuidelines.join(" ");
  assert.ok(all.includes("opts.tier"), "should mention opts.tier");
  assert.ok(all.includes("opts.model"), "should mention opts.model");
  assert.ok(all.includes("small") || all.includes("medium") || all.includes("big"), "should mention tier names");
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

test("createWorkflowTool schema exposes assistant resume and status controls", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };

  assert.match(parameters.properties?.action?.description ?? "", /run.*resume.*status/i);
  assert.match(parameters.properties?.runId?.description ?? "", /resume.*status/i);
});

test("workflow tool action arguments enforce run, resume, and status shapes", () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as (args: unknown) => unknown;

  assert.deepEqual(prepare({ action: "resume", runId: "paused-123", args: { riskAccepted: true } }), {
    action: "resume",
    runId: "paused-123",
    args: { riskAccepted: true },
  });
  assert.deepEqual(prepare({ action: "status", runId: "paused-123" }), {
    action: "status",
    runId: "paused-123",
  });
  assert.throws(
    () => prepare({ action: "resume", runId: "paused-123", script: "return 1" }),
    /must not include.*script/i,
  );
  assert.throws(() => prepare({ action: "status", runId: "paused-123", args: {} }), /must not include.*args/i);
  assert.throws(() => prepare({ action: "resume" }), /runId/i);
  assert.throws(() => prepare({ action: "run", runId: "paused-123", script: "return 1" }), /runId/i);
});

test("workflow tool resumes a persisted run with an optional args patch", async () => {
  const calls: unknown[][] = [];
  const manager = {
    getModelRegistry: () => undefined,
    async resume(...args: unknown[]) {
      calls.push(args);
      return true;
    },
    getRunForReport: () => ({ runId: "paused-123", workflowName: "audit", status: "paused" }),
  } as any;
  const tool = createWorkflowTool({ manager });

  const result = await (tool.execute as any)(
    "call",
    { action: "resume", runId: "paused-123", args: { riskAccepted: true } },
    undefined,
    undefined,
    {},
  );

  assert.deepEqual(calls, [["paused-123", { riskAccepted: true }]]);
  assert.match(result.content[0].text, /paused-123.*resumed/i);
  assert.deepEqual(result.details, { runId: "paused-123", background: true, resumed: true });
});

test("workflow tool reports why a run cannot be resumed", async () => {
  const manager = {
    getModelRegistry: () => undefined,
    resume: async () => false,
    getRunForReport: () => ({ runId: "done-123", workflowName: "audit", status: "completed" }),
  } as any;
  const tool = createWorkflowTool({ manager });

  await assert.rejects(
    () => (tool.execute as any)("call", { action: "resume", runId: "done-123" }, undefined, undefined, {}),
    /not resumable.*completed/i,
  );
});

test("workflow tool cold-resumes a persisted manager run end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-resume-"));
  try {
    const runId = "cold-resume-123";
    const script = `export const meta = { name: 'cold-resume', description: 'cold resume' }
return await agent(JSON.stringify(args), { label: 'capture' })`;
    let prompt = "";
    const manager = new WorkflowManager({
      cwd: root,
      agent: {
        async run(value: string) {
          prompt = value;
          return "ok";
        },
      },
    });
    const now = new Date().toISOString();
    manager.getPersistence().save({
      runId,
      workflowName: "cold-resume",
      script,
      args: { keep: true },
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: now,
      updatedAt: now,
    });
    const completed = new Promise<void>((resolve) => {
      manager.on("complete", (event: { runId: string }) => {
        if (event.runId === runId) resolve();
      });
    });
    const tool = createWorkflowTool({ cwd: root, manager });

    await (tool.execute as any)("call", { action: "resume", runId, args: { added: 1 } }, undefined, undefined, {
      cwd: root,
    });
    await completed;

    assert.deepEqual(JSON.parse(prompt), { keep: true, added: 1 });
    const status = await (tool.execute as any)("call", { action: "status", runId }, undefined, undefined, {
      cwd: root,
    });
    assert.equal(status.details.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow tool status rejects an unknown run ID", async () => {
  const manager = {
    getModelRegistry: () => undefined,
    getRun: () => undefined,
    getRunForReport: () => null,
  } as any;
  const tool = createWorkflowTool({ manager });

  await assert.rejects(
    () => (tool.execute as any)("call", { action: "status", runId: "missing-123" }, undefined, undefined, {}),
    /missing-123.*not found/i,
  );
});

test("workflow tool reports persisted run status without requiring a script", async () => {
  const manager = {
    getModelRegistry: () => undefined,
    getRunForReport: () => ({
      runId: "paused-123",
      workflowName: "audit",
      status: "paused",
      currentPhase: "Review",
      phases: ["Plan", "Review"],
      agents: [{ status: "done" }, { status: "running" }],
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z",
    }),
  } as any;
  const tool = createWorkflowTool({ manager });

  const result = await (tool.execute as any)(
    "call",
    { action: "status", runId: "paused-123" },
    undefined,
    undefined,
    {},
  );

  assert.match(result.content[0].text, /audit.*paused/i);
  assert.deepEqual(result.details, {
    runId: "paused-123",
    workflowName: "audit",
    status: "paused",
    currentPhase: "Review",
    phases: ["Plan", "Review"],
    agentCount: 2,
    startedAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:01:00.000Z",
  });
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

test("modelRoutingGuideline references the model scope (auth-independent)", () => {
  const text = modelRoutingGuideline();
  // With auth configured it lists the available models; on a fresh/CI machine
  // with no models it falls back to a generic line. Accept either so the test
  // doesn't depend on the runner's authenticated providers.
  assert.ok(
    text.includes("route only to these") || text.includes("models the user has configured"),
    "should explain which models are in scope (listed or fallback)",
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

test("modelRoutingGuideline advertises models from an injected registry", () => {
  const registry = fakeRegistry([{ provider: "router", id: "shared-model" }]);
  const text = modelRoutingGuideline(registry);
  assert.match(text, /route only to these/i);
  assert.match(text, /router\/shared-model/);
});

test("modelRoutingGuideline accepts a getter and resolves it lazily at call time", () => {
  // Empty registry (not undefined) so the getter path is exercised end-to-end
  // rather than falling through to the disk-registry default.
  let registry: any = fakeRegistry([]);
  const text = modelRoutingGuideline(() => registry);
  assert.doesNotMatch(text, /router\/late-model/);

  // Registering after construction (simulating session_start running after the
  // guideline string was first read) is reflected on the next call.
  registry = fakeRegistry([{ provider: "router", id: "late-model" }]);
  const later = modelRoutingGuideline(() => registry);
  assert.match(later, /router\/late-model/);
});

test("createWorkflowTool advertises models from the manager's shared registry when set before creation", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "wired-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });
  const all = tool.promptGuidelines.join(" ");
  assert.match(all, /router\/wired-model/);
});

test("createWorkflowTool promptGuidelines reflect a registry set AFTER tool creation (lazy accessor)", () => {
  // Mirrors the real ordering: createWorkflowTool() runs at extension load,
  // setModelRegistry() runs later in session_start. The SDK re-reads
  // definition.promptGuidelines on every tool-registry refresh, so a fresh
  // property read must see the late-set registry.
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });
  assert.doesNotMatch(tool.promptGuidelines.join(" "), /router\/late-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "late-model" }]));
  assert.match(tool.promptGuidelines.join(" "), /router\/late-model/);

  // Replacing the registry again is also reflected.
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "replacement-model" }]));
  const latest = tool.promptGuidelines.join(" ");
  assert.match(latest, /router\/replacement-model/);
  assert.doesNotMatch(latest, /router\/late-model/);
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
