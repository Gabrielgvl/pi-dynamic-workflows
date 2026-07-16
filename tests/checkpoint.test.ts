import assert from "node:assert/strict";
import test from "node:test";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

test("checkpoint(): headless takes the declared default and journals it", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const ok = await checkpoint('Approve plan?', { default: true })
const name = await checkpoint('Pick a name', { default: 'fallback' })
return { ok, name }`;
  const res = await runWorkflow<{ ok: boolean; name: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.name, "fallback");
  assert.equal(journal.length, 2, "both checkpoints journaled");
});

test("checkpoint(): explicit null default is returned and journaled instead of falling back to true", async () => {
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<null>(
    `export const meta = { name: 'null-default', description: 'explicit null' }
return await checkpoint('Optional value?', { default: null })`,
    {
      agent: noopAgent,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(journal[0].result, null);
});

test("checkpoint(): headless object defaults use independent JSON snapshots", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'default-snapshot', description: 'default snapshot' }
const shared = { count: 1 }
const value = await checkpoint('Choose', { default: { first: shared, second: shared } })
value.first.count = 9
return value`;
  const result = await runWorkflow<{ first: { count: number }; second: { count: number } }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  assert.deepEqual(result.result, { first: { count: 9 }, second: { count: 1 } });
  assert.deepEqual(journal[0].result, { first: { count: 1 }, second: { count: 1 } });
});

test("checkpoint(): headless 'abort' throws when no UI is threaded in", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('Approve?', { headless: 'abort' })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /human input|headless/i);
});

test("checkpoint(): uses the threaded confirm when present", async () => {
  let asked = "";
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', { kind: 'confirm' })`;
  const res = await runWorkflow<string>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async (p) => {
      asked = p;
      return "yes";
    },
  });
  assert.equal(res.result, "yes");
  assert.equal(asked, "Proceed?");
});

test("checkpoint(): replays the journaled reply on resume (no re-prompt)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', {})
return { r }`;
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
    confirm: async () => {
      calledAgain = true;
      return "DIFFERENT";
    },
  });
  assert.equal(second.result.r, "approved", "reply replays from the journal");
  assert.equal(calledAgain, false, "confirm is not called again on resume");
});

test("checkpoint(): replies and replay are independent deterministic JSON snapshots", async () => {
  const shared = { count: 1 };
  const reply = { first: shared, second: shared };
  const journal = new Map<number, JournalEntry>();
  const script = `export const meta = { name: 'checkpoint-snapshot', description: 'snapshot isolation' }
const value = await checkpoint('Choose', {})
value.first.count = 9
return value`;

  const live = await runWorkflow<{ first: { count: number }; second: { count: number } }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => reply,
    onAgentJournal: (entry) => journal.set(entry.index, entry),
  });
  assert.deepEqual(live.result, { first: { count: 9 }, second: { count: 1 } });
  assert.deepEqual(journal.get(0)?.result, { first: { count: 1 }, second: { count: 1 } });
  assert.deepEqual(reply, { first: { count: 1 }, second: { count: 1 } });

  const replay = await runWorkflow<{ first: { count: number }; second: { count: number } }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
    confirm: async () => {
      throw new Error("must not re-prompt");
    },
  });
  assert.deepEqual(replay.result, { first: { count: 9 }, second: { count: 1 } });
  assert.deepEqual(journal.get(0)?.result, { first: { count: 1 }, second: { count: 1 } });
});

test("checkpoint(): every result-affecting option participates in replay identity", async () => {
  const baseOptions = {
    default: { version: 1 },
    headless: "default",
    kind: "select",
    choices: ["a"],
    timeoutMs: 10,
  } as const;
  const scriptFor = (options: unknown) => `export const meta = { name: 'checkpoint-options', description: 'options' }
return await checkpoint('Choose', ${JSON.stringify(options)})`;
  const journal = new Map<number, JournalEntry>();
  let prompts = 0;
  const confirm = async () => `reply-${++prompts}`;

  await runWorkflow(scriptFor(baseOptions), {
    agent: noopAgent,
    persistLogs: false,
    confirm,
    onAgentJournal: (entry) => journal.set(entry.index, entry),
  });

  for (const edited of [
    { ...baseOptions, default: { version: 2 } },
    { ...baseOptions, headless: "abort" },
    { ...baseOptions, kind: "input" },
    { ...baseOptions, choices: ["b"] },
    { ...baseOptions, timeoutMs: 20 },
  ] as const) {
    await runWorkflow(scriptFor(edited), {
      agent: noopAgent,
      persistLogs: false,
      confirm,
      resumeJournal: journal,
    });
  }

  assert.equal(prompts, 6, "editing any checkpoint option must rerun the gate instead of replaying its old reply");
});

test("checkpoint(): rejects non-JSON defaults before journaling", async () => {
  const script = `export const meta = { name: 'checkpoint-default', description: 'default normalization' }
return await checkpoint('Choose', { default: () => true })`;
  let journaled = false;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        onAgentJournal: () => {
          journaled = true;
        },
      }),
    /checkpoint default.*deterministic JSON/i,
  );
  assert.equal(journaled, false);
});

test("checkpoint(): rejects unsupported interactive replies before journaling", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'checkpoint-reply', description: 'reply normalization' }
return await checkpoint('Choose', {})`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        confirm: async () => ({ createdAt: new Date(0) }),
        onAgentJournal: (entry) => journal.push(entry),
      }),
    /checkpoint reply.*deterministic JSON/i,
  );
  assert.equal(journal.length, 0);
});

test("checkpoint(): rejects an explicit undefined default instead of treating it as absent", async () => {
  const script = `export const meta = { name: 'checkpoint-undefined', description: 'undefined default' }
return await checkpoint('Choose', { default: undefined })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false }),
    /checkpoint default.*deterministic JSON/i,
  );
});

test("checkpoint(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('a', { default: 1 })
await checkpoint('b', { default: 1 })
await checkpoint('c', { default: 1 })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2 }), /limit/i);
});
