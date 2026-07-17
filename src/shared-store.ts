/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store additively; internal sequence metadata preserves actual parallel
 * write order without changing the historical plain-object delta shape.
 *
 * `deltaKey` must be unique across every concurrently active journal scope, not
 * just within one run's callSeq. A nested `workflow()` restarts callSeq at 0
 * while inheriting the parent's store, so callers use the full hierarchical
 * journal call key. Scope tracking separately records the latest sequenced write
 * per key so a nested wrapper reflects final live write order, including failed
 * attempts and replayed child deltas.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface SequencedWrite {
  value: unknown;
  sequence: number;
}

export interface SequencedStoreDelta {
  values: Record<string, unknown>;
  /** Internal journal metadata; `values` retains the historical public shape. */
  sequences: Record<string, number>;
}

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  private readonly mapSequences = new Map<string, number>();
  // Sequence is internal: public journal deltas retain the historical plain-object shape.
  private writeSequence = 0;
  private readonly agentDeltas = new Map<string, Map<string, SequencedWrite>>();
  private readonly scopeWrites = new Map<string, Map<string, SequencedWrite>>();

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    const write = { value, sequence: ++this.writeSequence };
    this.applyWrite(key, write);
  }

  /**
   * Store a value and record the write in the per-agent delta for the full
   * hierarchical `deltaKey`. When `scopeKey` is supplied, also retain the latest
   * sequenced write for the enclosing nested wrapper.
   */
  trackPut(key: string, value: unknown, deltaKey: string, scopeKey?: string): void {
    const write = { value, sequence: ++this.writeSequence };
    this.applyWrite(key, write);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = new Map<string, SequencedWrite>();
      this.agentDeltas.set(deltaKey, delta);
    }
    delta.set(key, write);
    if (scopeKey) this.recordScopeWrite(scopeKey, key, write);
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    return this.commitSequencedDelta(deltaKey).values;
  }

  /** Extract a delta together with private ordering metadata for workflow journals. */
  commitSequencedDelta(deltaKey: string): SequencedStoreDelta {
    const delta = this.agentDeltas.get(deltaKey);
    this.agentDeltas.delete(deltaKey);
    return delta ? sequencedDelta(delta) : { values: {}, sequences: {} };
  }

  /**
   * Extract writes left by settled attempts in a nested journal scope. Failed
   * attempts are not journaled individually, but a caller may catch their error;
   * their observable store writes therefore belong to the enclosing wrapper.
   */
  commitScopeDeltas(scopeKey: string): Record<string, unknown> {
    return this.commitSequencedScopeDeltas(scopeKey).values;
  }

  /** Extract a nested scope delta together with its original write ordering. */
  commitSequencedScopeDeltas(scopeKey: string): SequencedStoreDelta {
    const writes = this.scopeWrites.get(scopeKey);
    this.scopeWrites.delete(scopeKey);
    const deltaPrefix = `${scopeKey}/call:`;
    for (const deltaKey of this.agentDeltas.keys()) {
      if (deltaKey.startsWith(deltaPrefix)) this.agentDeltas.delete(deltaKey);
    }
    return writes ? sequencedDelta(writes) : { values: {}, sequences: {} };
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   */
  applyDelta(delta: Record<string, unknown>, scopeKey?: string, sequences?: Record<string, number>): void {
    for (const [key, value] of Object.entries(delta)) {
      const journalSequence = sequences?.[key];
      const write = {
        value,
        sequence:
          typeof journalSequence === "number" && Number.isSafeInteger(journalSequence) && journalSequence > 0
            ? journalSequence
            : this.writeSequence + 1,
      };
      this.writeSequence = Math.max(this.writeSequence, write.sequence);
      this.applyWrite(key, write);
      if (scopeKey) this.recordScopeWrite(scopeKey, key, write);
    }
  }

  /**
   * Replay one completed wrapper as an atomic current-generation mutation.
   * Historical sequences determine only the order inside the wrapper; fresh
   * store sequences make sibling wrapper order follow this generation's replay.
   */
  applyRebasedDelta(delta: Record<string, unknown>, sequences?: Record<string, number>): SequencedStoreDelta {
    const ordered = Object.entries(delta)
      .map(([key, value], index) => ({ key, value, index, sequence: sequences?.[key] }))
      .sort((left, right) => {
        const leftSequence = validSequence(left.sequence);
        const rightSequence = validSequence(right.sequence);
        if (leftSequence !== undefined && rightSequence !== undefined) return leftSequence - rightSequence;
        if (leftSequence !== undefined) return -1;
        if (rightSequence !== undefined) return 1;
        return left.index - right.index;
      });
    const rebased = new Map<string, SequencedWrite>();
    for (const { key, value } of ordered) {
      const write = { value, sequence: ++this.writeSequence };
      this.applyWrite(key, write);
      rebased.set(key, write);
    }
    return sequencedDelta(rebased);
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    this.mapSequences.clear();
    this.writeSequence = 0;
    for (const [key, value] of Object.entries(snap)) this.put(key, value);
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.mapSequences.clear();
    this.agentDeltas.clear();
    this.scopeWrites.clear();
    this.writeSequence = 0;
  }

  private applyWrite(key: string, write: SequencedWrite): void {
    const currentSequence = this.mapSequences.get(key) ?? Number.NEGATIVE_INFINITY;
    if (write.sequence < currentSequence) return;
    this.map.set(key, write.value);
    this.mapSequences.set(key, write.sequence);
  }

  private recordScopeWrite(scopeKey: string, key: string, write: SequencedWrite): void {
    let scoped = this.scopeWrites.get(scopeKey);
    if (!scoped) {
      scoped = new Map<string, SequencedWrite>();
      this.scopeWrites.set(scopeKey, scoped);
    }
    const current = scoped.get(key);
    if (!current || write.sequence >= current.sequence) scoped.set(key, write);
  }
}

function validSequence(sequence: number | undefined): number | undefined {
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

function sequencedDelta(writes: Map<string, SequencedWrite>): SequencedStoreDelta {
  const ordered = [...writes.entries()].sort(([, left], [, right]) => left.sequence - right.sequence);
  return {
    values: Object.fromEntries(ordered.map(([key, write]) => [key, write.value])),
    sequences: Object.fromEntries(ordered.map(([key, write]) => [key, write.sequence])),
  };
}

/**
 * Create the `store_put` and `store_get` tool definitions bound to a specific
 * `SharedStore` instance. Inject the returned array into every agent in the run
 * via `systemTools` so all agents, including those with a restrictive
 * `tools` allowlist, can read and write shared state.
 *
 * For workflow-internal use where delta-journaling is needed, use
 * `createAgentStoreTools(store, deltaKey)` instead — it attributes each put to
 * the given agent (via a run-unique deltaKey) so the write can be replayed
 * correctly on resume.
 */
export function createSharedStoreTools(store: SharedStore): ToolDefinition[] {
  const storePut = defineTool({
    name: "store_put",
    label: "Store Put",
    description:
      "Write a value to the shared run store. Any other agent in this workflow run can read it with store_get. Overwrites any existing value for the key. Note: when two parallel agents write the same key, the last write wins — no merge is performed.",
    promptSnippet: "Write a value to the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to store the value under." }),
      value: Type.Any({ description: "The value to store (any JSON-serializable value)." }),
    }),
    async execute(_id: string, params: { key: string; value: unknown }) {
      store.put(params.key, params.value);
      return {
        content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
        details: { key: params.key },
      };
    },
  }) as unknown as ToolDefinition;

  const storeGet = defineTool({
    name: "store_get",
    label: "Store Get",
    description:
      "Read a value from the shared run store previously written by store_put. Returns the stored value, or null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      const found = store.has(params.key);
      const value = store.get(params.key);
      const text = found
        ? `Value for key "${params.key}": ${JSON.stringify(value)}`
        : `Key "${params.key}" not found in store.`;
      return {
        content: [{ type: "text", text }],
        details: { key: params.key, value: found ? value : null, found },
      };
    },
  }) as unknown as ToolDefinition;

  return [storePut, storeGet];
}

/**
 * Create per-agent store tools that attribute writes to a hierarchical
 * `deltaKey` and, when supplied, its enclosing journal `scopeKey` (see the
 * `SharedStore` class doc for why a bare callIndex is insufficient).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export function createAgentStoreTools(store: SharedStore, deltaKey: string, scopeKey?: string): ToolDefinition[] {
  const storePut = defineTool({
    name: "store_put",
    label: "Store Put",
    description:
      "Write a value to the shared run store. Any other agent in this workflow run can read it with store_get. Overwrites any existing value for the key. Note: when two parallel agents write the same key, the last write wins — no merge is performed.",
    promptSnippet: "Write a value to the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to store the value under." }),
      value: Type.Any({ description: "The value to store (any JSON-serializable value)." }),
    }),
    async execute(_id: string, params: { key: string; value: unknown }) {
      store.trackPut(params.key, params.value, deltaKey, scopeKey);
      return {
        content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
        details: { key: params.key },
      };
    },
  }) as unknown as ToolDefinition;

  const storeGet = defineTool({
    name: "store_get",
    label: "Store Get",
    description:
      "Read a value from the shared run store previously written by store_put. Returns the stored value, or null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      const found = store.has(params.key);
      const value = store.get(params.key);
      const text = found
        ? `Value for key "${params.key}": ${JSON.stringify(value)}`
        : `Key "${params.key}" not found in store.`;
      return {
        content: [{ type: "text", text }],
        details: { key: params.key, value: found ? value : null, found },
      };
    },
  }) as unknown as ToolDefinition;

  return [storePut, storeGet];
}
