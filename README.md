<p align="center">
  <img src="https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/assets/readme/hero.png" width="100%" alt="pi-dynamic-workflows turns one prompt into a routed, resumable, cross-checked fleet of Pi subagents">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows"><img src="https://img.shields.io/npm/v/@quintinshaw/pi-dynamic-workflows?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/for-Pi-7c3aed" alt="Built for Pi"></a>
</p>

<p align="center">
  <a href="https://quintinshaw.github.io/pi-dynamic-workflows/">Documentation</a> ·
  <a href="https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows">npm</a> ·
  <a href="https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows">Pi package</a>
</p>

Turn one request into a JavaScript orchestration script that fans work out across isolated subagents, routes each task to the right model, cross-checks the results, and returns one synthesized answer. Intermediate work stays in script variables instead of filling your chat context.

Built for **codebase-wide audits, multi-perspective review, large refactors, and source-checked research**—the jobs that are too broad for one agent and one context window.

![A real pi-dynamic-workflows run showing parallel agents and live progress](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/demo.gif)

## Start in 30 seconds

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

Run `/reload` in Pi, then ask naturally:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes and starts the workflow in the background. A live panel tracks progress while you keep working, and the final result is delivered back into the conversation automatically.

Keyword triggering is on by default: use the bounded word **workflow** or **workflows** in a message to force workflow mode, or run `/workflows run <prompt>` explicitly. Identifier-like text and paths such as `myworkflow`, `workflow_name`, and `src/workflow-editor.ts` do not trigger. You can change the keyword with `/workflows-trigger set pi-workflow` or disable it with `/workflows-trigger off`.

## Assistant `workflow` tool API

The original run shape remains valid: omitting `action` is exactly the same as `action: "run"`. Flat control actions let an assistant recover a run without asking the user to type a slash command.

| Action | Required | Optional | Rejected |
| --- | --- | --- | --- |
| omitted / `"run"` | exactly one of `script` or `scriptPath` | `cwd`, `args`, `background`, `maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, `tokenBudget`, `resumeFromRunId` | `runId`; whichever source field was not selected |
| `"status"` | — | `cwd`, `runId` | `script`, `scriptPath`, and all execution options |
| `"resume"` | `runId` | `cwd` | `script`, `scriptPath`, and all execution options |
| `"stop"` | `runId` | `cwd` | `script`, `scriptPath`, and all execution options |

```json
{ "action": "status", "cwd": "/workspace/project", "runId": "audit-abc123" }
```

`cwd` may be any existing host-accessible directory. The runtime checks that it exists and is a directory, canonicalizes it with `realpath`, and uses that canonical value for both execution and its isolated persistence namespace. It never calls global `process.chdir()`. Host permission callbacks remain responsible for access policy; there is no extension-owned approved-root allowlist.

`script` supplies inline source. `scriptPath` supplies a non-empty path to a host-accessible regular file of at most **1 MiB (1048576 bytes)**. Relative paths resolve from the canonical selected `cwd`; absolute paths are used directly. Final symlinks are followed, consistent with the existing host-accessible path policy, but the opened target must be a regular file. The runtime opens the path once with nonblocking flags where supported, validates that same descriptor, and performs a bounded read from it, so pathname replacement after open cannot switch the object being loaded. Files whose size changes while being read are rejected, including files that grow beyond the limit. The file is freshly opened on every tool invocation, after cwd selection, so edits made between invocations are observed. Missing, unreadable, oversized, directory, and other non-regular paths fail with an actionable error. This host-side loading does not expose filesystem access inside the workflow VM.

For edited-source iteration, a run action may pair `resumeFromRunId` with either `script` or `scriptPath`; the freshly loaded source is passed to the existing resume path. The control action `action: "resume"` is different: it rejects both source fields and resumes only the source already persisted with the run.

`status` with a run ID returns one redacted metadata record. Without an ID it returns at most 20 recent records from that cwd namespace, including persisted runs from other sessions for recovery. Status omits scripts, arguments, agent prompts/history, logs, journal values, and workflow results, and never scans another cwd namespace.

`resume` acquires the persisted run lease before reloading state, replays the journaled prefix once, and restores the captured effective limits, concurrency, retries, timeout, and token budget. The original session remains provenance; the requesting live session becomes the delivery target. `stop` requires the active lease owner or atomically acquires the lease for a persisted paused run. It does not call a model.

New run files include canonical `cwd`/`projectKey`, `originSessionId`/`deliverySessionId`, `executionOptions`, and a bounded deterministic `terminalSnapshot` for completed, failed, or explicitly aborted runs. Host-loss recovery is nonterminal (`paused` with `pauseReason: "host_lost"`) and deliberately has no terminal snapshot. Legacy JSON remains readable with canonical namespace identity, legacy `sessionId` provenance, and deterministic historical execution defaults.

Runtime consumers can import `WorkflowToolAction`, `WorkflowToolInput`, `WorkflowRunMetadata`, `PersistedExecutionOptions`, `TerminalSnapshot`, `WorkflowManagerRegistry`, `canonicalWorkflowCwd`, and the related manager/persistence option types from the package root.

If another Pi extension has already installed a custom editor component, pi-dynamic-workflows leaves it in place and keeps the submit-time workflow trigger active. In that compatibility mode, the animated keyword highlight and Backspace one-shot disarm affordance are skipped because the existing editor remains responsible for rendering and input handling; use `/workflows-trigger off` or `/workflows-trigger set <word>` when you need to discuss workflow/workflows without auto-triggering, including in future sessions. Editor composition is load-order dependent: whichever extension installs a visual editor last owns the editor surface, while pi-dynamic-workflows still keeps its submit-time hook registered.

## How it works

![A prompt becomes deterministic orchestration, parallel routed agents, verification, and one result](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/assets/readme/workflow.png)

1. **Orchestrate** — Pi writes a deterministic JavaScript workflow with `agent()`, `parallel()`, `pipeline()`, and `phase()`.
2. **Fan out** — fresh subagent sessions run concurrently, optionally on different models or isolated git worktrees.
3. **Verify and return** — the workflow cross-checks findings, journals completed work for resume, and delivers one result.

The orchestration itself is plain JavaScript:

```js
export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify the findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, {
      tier: 'medium',
      isolation: 'worktree',
    }),
  ),
)

phase('Verify')
return await agent(
  'Synthesize and double-check these findings:\n' + findings.join('\n\n'),
  { tier: 'big' },
)
```

## Why use it

- **Real parallel orchestration** — fan out up to 16 concurrent and 1000 total subagents from one orchestration script.
- **Per-agent model routing** — use `small`, `medium`, or `big` tiers, or choose an exact provider/model and thinking level.
- **Journaled resume** — replay completed agents after interruption without rerunning them or spending their tokens again. The orchestrator can also resume with **edited source** from `script` or `scriptPath` (`resumeFromRunId`): unchanged `agent()` calls replay from cache and only edited/new ones re-run — so a single bad prompt no longer means paying to re-run the whole workflow.
- **Git worktree isolation** — let parallel agents edit safely on throwaway branches with `isolation: "worktree"`.
- **Measured usage** — report real tokens and cost from each subagent session; add run, phase, or agent budgets only when you want them.
- **Visible background runs** — track phases, agents, models, fresh/cache tokens, cost, and live tok/s from the progress panel or `/workflows` navigator.
- **Quality patterns** — compose `verify()`, `judgePanel()`, `loopUntilDry()`, and `completenessCheck()` instead of rebuilding review loops.
- **Reusable workflows** — save any run as a command and call saved workflows from other workflows.

## Built-in workflows

```text
/deep-research <question>   source-checked web research with citations
/adversarial-review <task>  findings challenged by skeptical reviewers
/multi-perspective "<topic>" [angle …]
                            independent angles followed by synthesis
/code-review [target]       7 parallel review angles plus verification
/codebase-audit <scope> "<check>" …
                            parallel checks followed by cross-validation
```

`/code-review` defaults to the current working diff. It also accepts a git range, a file, or a GitHub PR number:

```text
/code-review
/code-review HEAD~3..HEAD
/code-review src/foo.ts
/code-review 42
```

For an always-on exhaustive mode, use `/ultracode`; `/effort high` is the lighter standing option.

## Commands

| Command | Purpose |
| --- | --- |
| `/workflows` | Open the interactive run navigator |
| `/workflows run <prompt>` | Force a workflow even when keyword triggering is off |
| `/workflows status <id>` | Watch a run and print its result when complete |
| `/workflows pause\|resume\|stop\|rm <id>` | Control a run |
| `/workflows save <name>` | Save the latest script as a reusable command |
| `/workflows-trigger off\|on\|status` | Control automatic keyword triggering |
| `/workflows-trigger set <word>\|reset` | Set or reset the trigger word |
| `/workflows-progress compact\|detailed\|status` | Choose the live-panel detail level, including fresh/cache token splits |
| `/workflows-progress-max <N>` | Limit agents shown per phase in detailed mode |
| `/workflows-models` | Map model tiers and thinking levels |
| `/ultracode [off]` | Toggle exhaustive automatic workflows |
| `/effort off\|high\|ultra` | Set the standing orchestration effort |

In the navigator: `↑/↓` select · `enter/→` open · `esc/←` back · `p` pause · `x` stop · `r` restart · `s` save · `q` quit.

## Runtime reference

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent; optionally validate its result with JSON Schema |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently and preserve input order |
| `pipeline(items, ...stages)` | Fan items through sequential stages |
| `phase(title, { budget? })` | Group work in the live view and optionally set a phase budget |
| `verify` / `judgePanel` | Cross-check a result or choose the best candidate |
| `loopUntilDry` / `completenessCheck` | Repeat discovery until no new findings remain |
| `workflow(name, args)` | Run a saved workflow inline |
| `checkpoint(prompt, opts)` | Add a journaled human-approval gate |
| `releaseWorktree(handle)` | Idempotently release a runtime-issued retained worktree |
| `budget` | Inspect real tokens spent and remaining |

| Agent option | Description |
| --- | --- |
| `tier` | `small`, `medium`, or `big` model routing |
| `model` | Exact `provider/modelId` or `provider/modelId:thinking`; overrides `tier` |
| `agentType` | Named role, tool, and model definition |
| `isolation` | Use `"worktree"` for conflict-free parallel edits |
| `retainWorktree` | With worktree isolation, return `{ result, worktree }` and retain it for later steps |
| `worktree` | Bind to a retained producer's opaque handle; cannot be combined with isolation or `retainWorktree: true` |
| `schema` | JSON Schema for a validated structured result |
| `label` / `phase` | Display label and phase override |
| `timeoutMs` / `retries` | Optional per-agent timeout and recoverable-failure retries |

The [full documentation](https://quintinshaw.github.io/pi-dynamic-workflows/) covers every option, structured output, determinism, saved workflows, and operational control.

<details>
<summary><strong>Model tiers and run controls</strong></summary>

Model tiers live at `~/.pi/workflows/model-tiers.json` and accept Pi CLI-style thinking suffixes:

```json
{
  "tiers": {
    "small": "openai-codex/gpt-5.4-mini:low",
    "medium": "openai-codex/gpt-5.4:medium",
    "big": "openai-codex/gpt-5.5:xhigh"
  }
}
```

Use `/workflows-models` to edit them interactively. Without a config, the extension ranks authenticated models by capability hints and assigns distinct models when possible.

Runs have no default token budget or per-agent hard timeout. Add `tokenBudget`, `agentTimeoutMs`, phase budgets, or agent `timeoutMs` when you need explicit gates. `concurrency` is clamped to 16; `agentRetries` retries only recoverable failures. Defaults can be set in `~/.pi/workflows/settings.json`.

</details>

<details>
<summary><strong>Storage, resume, and persisted sessions</strong></summary>

Extension state lives outside the repository under `~/.pi/workflows`:

- global settings and tiers: `~/.pi/workflows/settings.json` and `model-tiers.json`
- project runs, journals, locks, and saved overrides: `~/.pi/workflows/projects/<project>/`
- older project-local `.pi/workflows/runs` and `.pi/workflows/saved` remain readable as fallbacks

Subagents are in-memory by default. Set `persistAgentSessions: true` to retain full transcripts in Pi's standard session directory. This creates one file per agent and may store sensitive material that an agent read, so enable it deliberately.

Completed background runs persist their full result in the project run JSON. The conversation delivery includes a pointer to that file when the visible summary is shortened.

</details>

<details>
<summary><strong>Keyword trigger and editor compatibility</strong></summary>

Set a literal, case-insensitive custom trigger in `~/.pi/workflows/settings.json`:

```json
{
  "keywordTriggerWord": "pi-workflow"
}
```

The default `workflow` also matches `workflows`; a custom word matches exactly. Trigger words are case-insensitive and Unicode identifier-bounded, and do not activate inside paths, slash commands, or identifier-like text. If another extension owns Pi's custom editor, the submit-time trigger still works, but animated keyword highlighting and Backspace one-shot disarm are unavailable. Editor visuals are load-order dependent.

</details>

<details>
<summary><strong>How it maps to Claude Code dynamic workflows</strong></summary>

| Claude Code dynamic workflows | pi-dynamic-workflows on Pi |
| --- | --- |
| Code-mode orchestration | JavaScript `agent()` / `parallel()` / `pipeline()` / `phase()` in a VM realm (for determinism, not a security boundary) |
| Isolated subagent contexts | Fresh in-memory Pi sessions; results remain in variables |
| Structured outputs | JSON Schema validation with bounded repair |
| Background runs | Non-blocking run, live panel, and automatic result delivery |
| Resume | Journaled replay of the unchanged completed prefix, including edit-and-resume with a revised script (`resumeFromRunId`) |
| Model selection | Per-agent and per-phase routing across authenticated providers |
| Ultracode | `/ultracode` or `/effort ultra` |
| Additional Pi features | Worktree isolation, real cost accounting, deep research, and quality-pattern helpers |

</details>

## Determinism and limits

Workflow scripts run in a Node `vm` sandbox. `Date.now()`, `Math.random()`, `new Date()`, `require`, `import`, filesystem access, and network access are unavailable inside the orchestration script. Subagents use their assigned tools; keeping the orchestrator deterministic is what makes journal replay reliable.

### Durable accounting, retries, and nested workflow identity

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`; recoverable failures return `null` with diagnostics in `/workflows`. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; results in input order. |
| `pipeline(items, ...stages)` | Fan items through sequential stages `(prev, original, index)`. |
| `phase(title, { budget? })` | Group agents in the live view; optional per-phase token sub-budget. |
| `verify` / `judgePanel` / `loopUntilDry` / `completenessCheck` | Built-in quality patterns. |
| `workflow(nameOrScript, args?, { key? })` | Run a saved or raw workflow inline (shares global caps). Identical siblings require unique explicit keys. |
| `checkpoint(prompt, opts)` | A journaled, replayable human approval gate. |
| `releaseWorktree(handle)` | Idempotently release a runtime-issued retained worktree. |
| `budget` | `{ total, spent(), remaining() }` real-token tracker. |

| Agent option | Description |
| --- | --- |
| `tier` | `"small"` \| `"medium"` \| `"big"` — coarse model routing (configure via `/workflows-models`; tiers may store `provider/modelId:thinking`). |
| `model` | Exact `provider/modelId` or `provider/modelId:thinking` (always wins over `tier`). |
| `agentType` | A named definition (`.pi/agents/<name>.md` project-level, or `~/.pi/agent/agents/<name>.md` user-level — `~/.pi/agents/<name>.md` still works as a deprecated fallback) binding tools + model + role prompt. |
| `isolation: "worktree"` | Run in a throwaway git worktree for conflict-free parallel edits. |
| `retainWorktree: true` | Opt in to a retained producer envelope `{ result, worktree }`; requires resolved worktree isolation, either explicit or supplied by `agentType`. |
| `worktree: handle` | Run in the retained tree under exclusive FIFO access; cannot be combined with `isolation` or `retainWorktree: true`. An option-spread `retainWorktree: false` remains a consumer call. |
| `schema` | JSON Schema → the subagent returns a validated object. |
| `label` / `phase` / `timeoutMs` | Display label / phase override / optional per-agent hard timeout. Omit `timeoutMs` for no hard timeout. |
| `retries` | Retry attempts after a recoverable failure for this agent. Overrides the run-level `agentRetries`. A timed-out attempt is aborted and fully settled before any retry starts. Default `0`. |

Retained worktrees are owned by the root run, while nested workflows share access without taking global cleanup ownership. The handle is an opaque, in-memory capability: it contains no path, rejects malformed/unknown/cross-run use, and never survives resume. Producer and consumer calls are noncacheable; a nested workflow that creates or consumes a retained handle also makes its parent wrapper noncacheable, so resume reruns the retained producer and its dependent suffix instead of replaying a stale capability. Consumers admitted before release run one at a time in FIFO order. Calling `releaseWorktree(handle)` closes admission immediately, waits those admitted consumers, and then removes only the registered runtime-created worktree; repeated release is a successful no-op. Root settlement performs the same cleanup for unreleased handles after success, failure, abort, stop, or provider-limit pause.

New checkouts use an atomically allocated `pi-workflow-checkout-*` direct child of the canonical Git common directory rather than the repository worktree or legacy shared `.pi/worktrees` parent. This keeps ordinary and retained checkouts outside the main worktree's Git status and staging namespace, while the trusted direct-parent design prevents an intermediate directory from redirecting Git. Genuine v1/v2 identities use an explicit upgrade path; current v3/v4 registrations are never freshly adopted from stripped pathname data. Temporary branch creation is separate from `git worktree add`; immediately before Git is invoked, the runtime rechecks the checkout's canonical path and descriptor-bound device/inode identity. A rebound directory or symlink fails closed without passing the replacement path to Git, and rollback only touches the owned branch and original identity. From final creation through successful cleanup, supported platforms retain a process-local open directory descriptor keyed by opaque cleanup identity. Cleanup compares its `fstat` identity with the pathname `lstat` before claiming, retains the descriptor across retryable failures, and closes it after successful removal or fully rolled-back/fallback creation. Holding the original inode prevents numeric inode reuse on POSIX. Portable sentinel creation still requires a pinned directory descriptor and a verified `/proc/self/fd/<fd>` or `/dev/fd/<fd>` alias so the exclusive marker write is relative to the verified directory identity. Descriptor-retention unsupported and descriptor-open unsupported are distinct: the former may use this safe sentinel path, while descriptor-open or descriptor-alias unsupported environments fail closed and transactionally fall back without path-writing a proof. Each portable sentinel rule is appended as one uniquely ownership-tagged block. Cleanup verifies that exact block from the open exclude-file descriptor and neutralizes only its bytes in place, preserving the inode, metadata, hardlinks, concurrent appends, separators, and every byte outside the owned range. Harmless equal-length comment/whitespace blocks may remain in `.git/info/exclude`; Git ignore semantics are restored, but the file is intentionally not byte-for-byte shortened. Handles/descriptors are never serialized or exposed. If add fails after partial side effects, the runtime transactionally removes only the proof-bound checkout, its exact resolving registration, and the branch while it remains at the expected start commit and is not checked out elsewhere. Failed recovery is surfaced and persisted as bounded stage-and-identity diagnostics instead of silently falling back. Before destructive cleanup, the runtime also verifies the exact canonical registration path, repository common root, expected `pi/wf/` branch ref, per-worktree Git metadata directory, and a private runtime-issued registration marker, then atomically moves the verified filesystem identity to a deterministic, metadata-bound quarantine and re-verifies it before removal. If content deletion partially fails, the exact pending identity and backup ref remain available to the next release or root-settlement attempt; pre-destructive claims are never auto-promoted to destructive cleanup. Repository-wide destructive metadata cleanup is serialized across processes by a fully initialized unique owner file atomically hard-linked at the fixed lock pathname; release and stale reclaim verify inode plus token and unlink only that fixed link. Legacy directory locks, symlinks, and malformed owner files fail closed with bounded manual-recovery diagnostics. The marker is never exposed through the handle or persisted cleanup diagnostics. The creation SHA remains diagnostic identity metadata for normal agent cleanup and is not compared with mutable worktree `HEAD`, so agents may commit normally. Identity mismatches preserve the path and branch; if only the checkout directory is missing, matching Git metadata still allows the exact stale registration and branch to be cleaned.

Retained cleanup failures never replace the workflow result or original error. Successful `runWorkflow()` and manager results expose a bounded optional `worktreeCleanupFailures` list. `WorkflowManager.getRun(runId)` remains a live/in-memory API and returns `undefined` after a cold start; use `getRunMetadata(runId)` or `listRuns()` for persisted terminal diagnostics, and `listRunMetadata()` for bounded cross-session status. Foreground tool completion and background/resumed delivery keep the workflow status completed while adding a warning count and stages. Workflow logs add a path-free warning and direct callers do not need to register a callback to receive successful-run diagnostics. Error-path callers continue to receive the original thrown error; inspect manager status metadata or use `onWorktreeCleanupFailure` for recovery details. Every public, callback, log, tool, delivery, and persisted cleanup diagnostic is bounded and synthesized only from allowlisted structured fields such as stage and opaque recovery ID. Raw failure prose is never retained on those surfaces, so POSIX/Windows paths and path fragments cannot escape through punctuation, whitespace, quotes, or mixed separators; diagnostics never include canonical repository/checkout/quarantine paths, registration metadata, or the reusable handle.

Retained handles and cleanup ownership are intentionally limited to the current in-process execution. A hard host/process termination can leave a worktree registration, directory, and branch behind; a later cold resume may then fail closed on that deterministic identity until an operator inspects and recovers the repository state. The runtime does not scan paths or run an unsafe startup reaper. Durable host-loss recovery/reaping is a separate follow-up, not provided by this feature.

The exported low-level `createWorktree()` / `removeWorktree()` API remains plain-data compatible within the creating process: copied or JSON-round-tripped `Worktree` values can be removed when their `cleanupMetadata` is preserved unchanged and the process-local descriptor proof is still held (or the v4 sentinel fallback applies). After process loss, descriptor-backed cleanup fails closed rather than fresh-adopting a pathname. The metadata binds cleanup to the exact Git registration and is intentionally excluded from cleanup diagnostics. It is not a retained-worktree handle, and `releaseWorktree()` never accepts paths or low-level `Worktree` values.

```js
const produced = await agent('Edit the generated client.', {
  isolation: 'worktree',
  retainWorktree: true,
  schema: CLIENT_SCHEMA,
})
const verified = await agent('Run tests against those uncommitted edits.', {
  worktree: produced.worktree,
})
await releaseWorktree(produced.worktree)
return { generated: produced.result, verified }
```

By default, workflows do not set a run-wide token ceiling or per-agent hard timeout. `tokenBudget` and `phase(..., { budget })` are strengthened best-effort ceilings, not billing-hard caps: admission is checked immediately before each live attempt, charges survive resume, active attempts are cancelled when live usage reaches a ceiling, and delayed provider telemetry can still produce an honestly reported overshoot. Budget exhaustion is terminal when the script otherwise succeeds or catches/consumes an agent failure; an unrelated uncaught script error remains the primary failure, and an explicit parent abort remains terminal. Journal replay remains zero-cost. Use `agentTimeoutMs` or per-agent `timeoutMs` only when you want an explicit time bound. On timeout, the attempt is aborted and the runtime waits for it to settle before retrying, releasing its lease, cleaning up its worktree, or allowing resume; after configured retries are exhausted, `agent()` returns `null` like other recoverable failures. A non-cooperative custom agent can therefore keep the run blocked, but a caught or exhausted timeout does not make the whole logical run terminal by itself. A global fallback timeout can be set in `~/.pi/workflows/settings.json` as `{ "defaultAgentTimeoutMs": 600000 }`; set it to `null` or omit it for no default hard timeout.

Nested calls accept `workflow(nameOrScript, args?, { key?: string })`. The key is trimmed and must be non-empty. Within one parent, explicit keys must be unique; without a key, the typed canonical saved-name/raw-script plus arguments identity may occur only once. Canonical identity distinguishes omitted, `undefined`, `null`, special numbers, arrays, objects, and nested marker-like values while sorting object keys; cyclic values, functions, symbols, bigint values, and other unsupported argument shapes fail with a script-validation error instead of sharing a hash. Use keys for identical siblings and for reorder/insertion-stable accounting. Existing unambiguous unkeyed occurrence-0 accounting remains compatible, but keyed children start fresh rather than guessing charges from ambiguous legacy occurrences.

Duplicate sibling identity is enforced dynamically as each `workflow()` call is reached, not as a pre-execution whole-script guarantee. A previously completed keyed child may therefore already have durable descendant/wrapper checkpoints before a later duplicate is detected; those checkpoints are intentionally retained for incremental crash recovery, with no phase or usage charge transfer to the duplicate. Keyed descendant journals carry stable accounting-call identity, so if a child fails before its wrapper checkpoint, resume can still replay its completed child calls and execute only the unfinished suffix. Wrapper checkpoints remain positional, and child journals are persisted incrementally rather than staged behind a two-pass preflight.

For larger or flakier fan-outs, the `workflow` tool also accepts `concurrency` (max agents running at once, clamped to the runtime maximum of `16`) and `agentRetries` (retry attempts after a recoverable failure). Both can be defaulted in `~/.pi/workflows/settings.json` as `{ "defaultConcurrency": 4, "defaultAgentRetries": 2 }`; a per-run tool value overrides the default, and a per-agent `retries` overrides `agentRetries`. Retries default to `0` (off) unless configured or passed. Timeouts abort and fully settle before a configured retry; nonrecoverable errors abort the run.

Journal replay — including edit-and-resume via `resumeFromRunId` with inline `script` or freshly read `scriptPath` source — matches cached agent results by **positional call index** (the order in which `agent()` calls execute), the same contract Claude Code uses. Editing an `agent()` prompt in place reuses the cache up to that call and re-runs it and everything after. Inserting, removing, or reordering an `agent()` call before others shifts their positions and invalidates the cache from that point on (mismatched calls simply re-run — no crash). To preserve the cached prefix, keep the earlier still-good `agent()` calls unchanged and in the same order.

## Development

```bash
npm install
npm test     # Biome + TypeScript + unit tests
```

Features are also verified end-to-end against real Pi subagent sessions before release. See [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute.

## Credits

The code-mode orchestration idea comes from [Michael Livs' original pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project adds model routing, journaled resume, worktree isolation, measured usage, an interactive TUI, and built-in research and review workflows.

## License

MIT — see [LICENSE](./LICENSE).
