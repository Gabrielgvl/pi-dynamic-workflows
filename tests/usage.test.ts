import assert from "node:assert/strict";
import test from "node:test";
import {
  addJournalReplay,
  addUsageSample,
  createTokenUsage,
  restoreTokenUsage,
  UsageController,
  type UsageSample,
} from "../src/usage.js";

const measured: UsageSample = {
  input: 100,
  output: 50,
  total: 170,
  cost: 0.01,
  cacheRead: 15,
  cacheWrite: 5,
  reasoning: 20,
  provenance: "measured",
};

test("usage accounting preserves compatibility totals and records measured provider details", () => {
  const usage = createTokenUsage();

  addUsageSample(usage, measured);

  assert.deepEqual(
    {
      input: usage.input,
      output: usage.output,
      total: usage.total,
      cost: usage.cost,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    { input: 100, output: 50, total: 170, cost: 0.01, cacheRead: 15, cacheWrite: 5 },
  );
  assert.equal(usage.accounting.measured, 170);
  assert.equal(usage.accounting.estimated, 0);
  assert.equal(usage.accounting.legacyUnclassified, 0);
  assert.equal(usage.accounting.reasoning.tokens, 20);
  assert.equal(usage.accounting.reasoning.includedInOutput, true, "reasoning must not be added to output twice");
  assert.deepEqual(usage.accounting.providerCache, { read: 15, write: 5 });
});

test("estimated usage is distinguished from measured usage", () => {
  const usage = createTokenUsage();

  addUsageSample(usage, {
    input: 12,
    output: 8,
    total: 20,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
    provenance: "estimated",
  });

  assert.equal(usage.total, 20);
  assert.equal(usage.accounting.measured, 0);
  assert.equal(usage.accounting.estimated, 20);
});

test("legacy compatibility usage is restored as unclassified without fabricating attempt history", () => {
  const usage = restoreTokenUsage({ input: 40, output: 10, total: 50, cost: 0.2, cacheRead: 3, cacheWrite: 2 });

  assert.equal(usage.total, 50);
  assert.equal(usage.accounting.legacyUnclassified, 50);
  assert.equal(usage.accounting.measured, 0);
  assert.equal(usage.accounting.estimated, 0);
  assert.equal(usage.accounting.journalReplay, 0);
});

test("historical four-field usage normalizes missing cache and accounting details", () => {
  const usage = restoreTokenUsage({ input: 4, output: 2, total: 6, cost: 0.03 });

  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.schemaVersion, 1);
  assert.equal(usage.accounting.legacyUnclassified, 6);
});

test("a stable phase key never reuses a charged checkpoint with a different stored title", () => {
  const controller = new UsageController({
    checkpoint: {
      schemaVersion: 1,
      usage: createTokenUsage(),
      phaseBudgets: {
        "root/phase:Build": { title: "Other", budget: 100, charged: 75, warned: true },
      },
      attempts: {},
    },
  });

  controller.declarePhase("root/phase:Build", "Build", 120);

  assert.deepEqual(controller.checkpoint().phaseBudgets["root/phase:Build"], {
    title: "Build",
    budget: 120,
    charged: 0,
    warned: false,
  });
});

test("incremental accounting retains late cost and reasoning-only deltas", () => {
  const controller = new UsageController();
  const attemptId = controller.startAttempt("root/call:0", 1, "hash", undefined, new AbortController());
  controller.updateAttempt(
    attemptId,
    { input: 10, output: 0, total: 10, cost: 0, cacheRead: 0, cacheWrite: 0, provenance: "measured" },
    false,
  );
  controller.updateAttempt(
    attemptId,
    {
      input: 10,
      output: 0,
      total: 10,
      cost: 0.25,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 2,
      provenance: "measured",
    },
    false,
  );
  controller.settleAttempt(attemptId, "succeeded");

  assert.equal(controller.usage.total, 10);
  assert.equal(controller.usage.cost, 0.25);
  assert.equal(controller.usage.accounting.reasoning.tokens, 2);
});

test("the final telemetry reporter is marked exhausted without aborting it", () => {
  const controller = new UsageController({ tokenBudget: 100 });
  const abortController = new AbortController();
  const attemptId = controller.startAttempt("root/call:0", 1, "hash", undefined, abortController);

  controller.updateAttempt(
    attemptId,
    { input: 120, output: 0, total: 120, cost: 0, cacheRead: 0, cacheWrite: 0, provenance: "measured" },
    true,
    true,
  );

  assert.equal(abortController.signal.aborted, false);
  assert.deepEqual(controller.exhaustionFor(attemptId), {
    scope: "run",
    limit: 100,
    spent: 120,
    overshoot: 20,
  });
});

test("journal replay is visible but does not charge compatibility totals", () => {
  const usage = createTokenUsage();
  addUsageSample(usage, measured);

  addJournalReplay(usage, 170);

  assert.equal(usage.total, 170, "replay must remain zero-cost live work");
  assert.equal(usage.accounting.measured, 170);
  assert.equal(usage.accounting.journalReplay, 170);
});
