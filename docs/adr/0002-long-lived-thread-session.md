# ADR-0002: Long-Lived Thread Sessions — Replace Per-Turn `ClaudeSession` with a Persistent `ThreadSession`

**Date:** 2026-07-21
**Status:** Proposed

---

## Context

### Current architecture (verified against v0.19.14, not just the 07-14 sketch)

Every thread turn runs a **fresh Claude Agent SDK `query`**:

- `ClaudeSession.run()` (`src/ClaudeSession.ts:142-806`) is called once per user turn. It builds `Options`
  from scratch (`cwd`, `resume: sessionId`, MCP servers, model, permission mode, `canUseTool`, etc.,
  `:254-296`) and calls `query({ prompt: promptArg, options })` (`:339`).
- To keep the permission channel (`canUseTool` / `AskUserQuestion` / `ExitPlanMode`) alive across
  **background-task-driven multi-generation turns**, `promptArg` is a **held-open async generator**
  (`:313-335`) that only completes when the plugin explicitly resolves `inputReleased` via
  `releaseInput()`/`endInput()` (`:124-140`) — never on a fixed schedule. Passing a plain string instead
  sets the SDK's internal `isSingleUserTurn` flag, which force-closes stdin the instant the first
  `result` arrives; the comment at `:300-312` documents why that's unsafe once a background task keeps
  the CLI alive past that first result.
- The release gate (`case 'result':`, `:509-550`) only calls `releaseInput()` when **three** conditions
  hold simultaneously, each with its own tracking variable, added incrementally across two prior fixes
  (PR #296 v0.19.7, PR #298 v0.19.8):
  - `pendingBgTaskIds.size === 0` (`:390`, `task_started`/`task_updated`/`task_notification` bookkeeping)
  - `!sawTaskNotificationSinceLastResult` (`:407`, protects a `task_notification` that lands and is
    reacted to entirely within one `result` window)
  - `pendingInteractiveCallbacks === 0` (`:423`, a counter incremented at the top of `canUseTool` and
    decremented in `canUseTool`'s `finally`, `:175`/`:250` — this wraps the **entire** `canUseTool` body,
    so it already covers every tool-permission round-trip generically: `AskUserQuestion`, `OpenNewTab`,
    `EnterPlanMode`, `ExitPlanMode`, *and* the generic `onPermissionRequest` fallback used by Bash/Write/
    Edit/etc. This is broader than PR #298's title ("...pending ExitPlanMode / AskUserQuestion / permission
    prompts") suggests — it was already generalized to all tools when it shipped.)
- `ThreadManager` tracks two parallel maps: `sessions` (a turn actively running) and `lingeringSessions`
  (`:123`, a session whose `onDone` fired — thread looks idle, `status: 'waiting'` — but whose `run()`
  hasn't resolved because a background task is still streaming a further generation, `:904-939`).
  `LINGER_MAX_MS = 10 * 60 * 1000` (`:21`) is a safety-cap timer per thread (`lingerTimers`, `:125`) that
  force-calls `session.endInput()` if a lingering session never drains on its own.
  `isRunning(id)` (`:473-474`) is simply `sessions.has(id) || lingeringSessions.has(id)`.
- `git log` confirms PRs #300, #304–#309, #311–#319 shipped since the 07-14 investigation and none of
  them touch this machinery except **PR #310** (thread orchestrator — notes, proposed replies,
  event-driven wake-up), which is additive on top (it schedules *new* turns via the same `sendMessage()`
  path) and does not alter `ClaudeSession`/`lingeringSessions`/`LINGER_MAX_MS`. The sketch's description
  of the architecture is still accurate.

### The evidence

A fresh log audit found **962 real "Stream closed" / "Tool permission request failed" errors across 25
distinct threads**, dated every day from 07-16 (the day PR #298 shipped) through today (07-21), spanning
Bash, Write, Edit, and ExitPlanMode tool calls. Stage 1 (PR #296, #298) clearly narrowed the bug class but
did not close it.

### A second root cause, not identified in the 07-14 sketch

`pendingInteractiveCallbacks` only guards `ClaudeSession`'s **own** release check inside `run()`. It is a
private local variable — nothing exposes it to `ThreadManager`. But `ThreadManager` has an **independent**
path that force-ends a session's input regardless of that counter:

```ts
// src/ThreadManager.ts:1204-1219
private async unwindLingeringSession(threadId: string, session: ClaudeSession, timeoutMs = 5_000): Promise<void> {
  session.endInput();                                   // <-- unconditional, no pendingInteractiveCallbacks check
  const deadline = Date.now() + timeoutMs;
  while (this.lingeringSessions.get(threadId) === session && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (this.lingeringSessions.get(threadId) === session) {
    session.close();                                    // <-- hard-close if it hasn't drained in 5s
    ...
  }
}
```

This runs from `sendMessage()` whenever a **new** message arrives for a thread whose previous generation is
still lingering — a user typing a follow-up, a queued message dequeuing, or (new in PR #310) an orchestrator
wake-up firing into a thread. If that lingering generation currently has a tool-permission request in flight
(any tool — the `pendingInteractiveCallbacks` guard covers all of them, as noted above), `unwindLingeringSession`
calls `endInput()` on it anyway, and hard-closes it 5 seconds later if it hasn't unwound. Either way the
CLI's stdio reader sees EOF mid-request and force-rejects the pending control request — the exact "Stream
closed" / "Tool permission request failed" failure mode `transportErrorRecovery.ts` was built to paper over.

This is a **second, independent** race that Stage 1's guard structurally cannot cover, because the guard was
never plumbed into `ThreadManager`'s separate force-unwind path. It plausibly explains why the error rate
didn't drop after PR #298 shipped exactly the generic `pendingInteractiveCallbacks` guard: that guard fixed
the session's self-inflicted race but not the cross-object race between two `ClaudeSession` instances
competing for the same thread.

### Why this class of bug keeps reappearing

Both root causes trace to the same structural fact: **the plugin spins up a brand-new `query()`/subprocess
per turn**, and stitches turns together with ad-hoc flags (`pendingBgTaskIds`,
`sawTaskNotificationSinceLastResult`, `pendingInteractiveCallbacks`, `LINGER_MAX_MS`) trying to guess when
it's safe to let one turn's process die before the next turn's process needs to exist. Every guess that
misses a case reproduces this bug in a new shape. The fixes so far have been narrow patches over specific
misses, not a fix to the underlying premise.

---

## Decision

Replace the per-turn `ClaudeSession` + `lingeringSessions`/`lingerTimers` bookkeeping with a **long-lived
`ThreadSession`** — one instance per thread, not per turn — that owns a single `Query` for the thread's
active lifetime and exposes `send()` to push additional turns onto the **same still-open** input channel.
Because only one `Query` ever exists per thread, there is no second `ClaudeSession` to race against, and no
guessing about when it's "safe" to close stdin: it stays open until the `ThreadSession` itself is torn down.

### 1. SDK primitives — verified, with one correction to the sketch

Checked against `@anthropic-ai/claude-agent-sdk@0.3.207` (this repo's pinned version, `sdk.d.ts` +
decompiled `sdk.mjs`):

- `Query` (`sdk.d.ts:2230+`) confirms `interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`,
  `close()`, `getContextUsage()`, `supportedModels()`/`supportedAgents()` all exist with the signatures the
  current code already uses.
- `Options.resume?: string` confirmed (`sdk.d.ts:1761-1763`) — same resume mechanism the code uses today.
- `SDKSessionStateChangedMessage` (`sdk.d.ts:4245-4250`, `subtype: 'session_state_changed'`, states
  `'idle' | 'running' | 'requires_action'`) **is already defined in this SDK version**, confirming the
  sketch's forward-looking note — this is a message type the CLI can emit, not a hypothetical future one.
- **Correction:** the sketch describes `streamInput()` as if it were a "push more input without closing"
  primitive. It is not. Its actual implementation (decompiled `sdk.mjs`) writes each message from the given
  iterable to the transport, and once that iterable is exhausted — after first waiting for the first
  `result` if the query has "bidirectional needs" (i.e. `canUseTool`/elicitation configured) — it
  **unconditionally calls `transport.endInput()`**, the exact stdin-EOF that causes the CLI's stdio reader
  to force-reject in-flight control requests. Calling `q.streamInput()` again on an existing query is not a
  reopening of anything; it is "run one more iterable, then EOF," same as the `prompt` argument to `query()`
  itself (which is implemented via the same code path). The plugin's existing held-open generator
  (`ClaudeSession.ts:313-335`) already works around this by never letting the generator complete until the
  plugin decides to — that pattern, generalized to the thread's full lifetime rather than one turn, **is**
  the only mechanism available for keeping the permission channel open across turns. `ThreadSession.send()`
  therefore pushes onto the **same never-completing generator** handed to the single `query()` call made in
  `start()` — it does not call `q.streamInput()` per turn.

### 2. `ThreadSession` design

New file `src/ThreadSession.ts` replacing `src/ClaudeSession.ts` (the callback contract, `SessionCallbacks`,
and `formatToolSummary`/tool-name utilities are preserved verbatim — this is a lifecycle rewrite, not a
message-handling rewrite; the entire `switch (msg.type)` body in the current `run()`, `:433-778`, moves
into `ThreadSession` largely unchanged).

```ts
class ThreadSession {
  private query: Query | null = null;
  private inputQueue: SDKUserMessage[] = [];
  private inputWaiters: Array<(msg: IteratorResult<SDKUserMessage>) => void> = [];
  private turnInFlight = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async start(options: ThreadSessionOptions): Promise<void>   // builds Options once, opens the
                                                                // push-channel generator, calls query(),
                                                                // starts the message-pump loop (today's
                                                                // switch, minus the release-gate logic —
                                                                // `result` just fires onTurnDone(), nothing
                                                                // else closes anything)
  send(text: string, images?: ImageAttachment[], priority?: 'immediate' | 'queued'): void  // pushes an
                                                                // SDKUserMessage onto the open channel;
                                                                // resets the idle timer
  interruptTurn(): Promise<void>                               // q.interrupt()
  setModel(model?: string): Promise<void>                      // q.setModel() — no restart
  setPermissionMode(mode): Promise<void>                        // q.setPermissionMode() — no restart
  async restart(reason: 'cwd-change' | 'transport-error' | 'init-options-change'): Promise<void>
                                                                // close() then start() with resume
  close(): void                                                 // completes the channel, q.close()
  isIdle(): boolean                                             // !turnInFlight
}
```

`ThreadManager.sessions: Map<string, ThreadSession>` replaces both `sessions` and `lingeringSessions`.
**Deleted outright**: `lingeringSessions`, `lingerTimers`, `LINGER_MAX_MS`, `unwindLingeringSession()`
(`ThreadManager.ts:1204-1219`), `endInput()`/`releaseInput()` plumbing in `ClaudeSession`,
`pendingBgTaskIds`, `sawTaskNotificationSinceLastResult`. `pendingInteractiveCallbacks` also disappears as
a *release-gate* concern — there is no release gate to guard anymore — but the underlying signal (a
permission request is in flight) is still useful for UI ("waiting on you") and should be preserved as a
plain state flag on `ThreadSession`, not a gate.

`isRunning(id)` becomes `this.sessions.get(id)?.turnInFlight ?? false` — a simple event-derived boolean, no
second map to check.

Model/permission-mode changes (today: rebuild `Options` for the next `run()` call) become direct
`setModel()`/`setPermissionMode()` calls on the live `Query` — no restart needed, confirmed available per
§1.

cwd changes: `ThreadManager.setThreadCwd()` (`:330-341`) already clears `thread.sessionId` and treats a cwd
change as session-breaking (a resumed session can't cross Claude Code project directories — the comment at
`:331-336` already states this). Stage 2 makes this explicit rather than implicit: `setThreadCwd()` calls
`session.restart('cwd-change')` if a `ThreadSession` exists for that thread. Not a new behavior — a cleaner
implementation of the one that exists today (today, the cwd change simply causes the *next* `run()` call to
start unresumed; Stage 2 makes that an explicit, immediate `close()`+`start()` rather than an implicit
consequence of the next message).

Transport-error retry: `transportErrorRecovery.ts`'s existing trigger logic (`isTransportClosedError`,
`shouldAutoRetryTransportError`, `MAX_TRANSPORT_ERROR_AUTO_RETRIES = 1`) is reused unchanged — "process
died → respawn with `resume`" becomes `session.restart('transport-error')`.

The exact bug in §"Context" is fixed by construction: when a new message arrives for a thread with a turn
already in flight, `ThreadSession.send()` **queues** it onto the same open channel (or the CLI's own
multi-turn queuing, once `send()` semantics are confirmed against the live CLI in implementation — see Open
Questions) instead of `ThreadManager` spinning up competitor code that force-closes the live `Query`. There
is only ever one `Query` per thread, so there is nothing to race.

### 3. Lifecycle / resource policy (the sketch explicitly deferred this — this ADR does not)

- **Desktop-only concern, confirmed.** Mobile has no `child_process` (`ClaudeSession`/`ThreadSession` will
  continue to guard the same way); `MobileView`/`RelayClient`/`MobileThreadStore` proxy all thread activity
  through a desktop host over WebSocket (`src/relay-protocol.ts`), so "how many subprocesses does this cost"
  only applies on the desktop host, which is already shelling out to the real `claude` CLI binary via
  `pathToClaudeCodeExecutable` today.
- **Archived threads don't count.** `archiveThread()` (`main.ts:361-369`) calls `manager.deleteThread(id)`,
  removing the thread from `ThreadManager.threads` entirely — an archived thread already cannot hold a
  session today, and won't under Stage 2 either. The ~70+ archived threads in the vault are not part of the
  resource question; the ~11 currently-active (non-archived) threads are the relevant baseline, though that
  count isn't intrinsically capped and can grow (PR #310's orchestrator/wake-up features mean a thread can
  be "alive" — needs to run a scheduled turn — without a visible tab open).
- **Recommendation: lazy spawn on first message, not eager on thread creation.** Matches today's behavior
  (no session exists until a prompt is sent) and avoids paying subprocess+MCP-connection cost for threads
  the user created but hasn't used yet.
- **Recommendation: idle reaper, not "warm forever."** Close (not destroy — `sessionId` persists, so a
  future message resumes cleanly) a `ThreadSession` after a period of no traffic **and** no pending
  scheduled wake-up for that thread. Reuse the existing `LINGER_MAX_MS = 10 * 60 * 1000` constant/value as
  the starting idle timeout — it's already a codebase-established number for "how long is too long to keep
  a Claude subprocess sitting around," just repurposed from "force-end a stuck lingering session" to "close
  a genuinely idle warm session."
- **Recommendation: switching tabs must NOT close a session.** A background `/loop` or cron-scheduled
  orchestrator wake-up needs its `ThreadSession` alive whether or not that thread's tab is currently
  focused. Only true inactivity (no messages sent, no scheduled wake-up due soon) should trigger the
  reaper — gate the reaper check on both idle-time *and* absence of a pending `ScheduleWakeup`/cron entry
  for that thread.
- **No hard cap on concurrently-warm sessions for v1.** Flagged as an open question below — there isn't
  enough real usage data yet (11 active threads today) to size a cap without guessing, and getting it wrong
  in either direction (too low: forces cold-starts on active work; too high: doesn't bound worst-case memory)
  is worse than deferring it one iteration with the idle reaper as the only control.

### 4. Migration risk

- **`data.json`: no schema migration required.** `thread.sessionId` remains the resume anchor exactly as
  today; `ThreadSession.start()` passes it as `options.resume` exactly like `ClaudeSession.run()` does now.
  No new persisted fields are strictly needed for Stage 2 itself (a `lastActivityAt` for the idle reaper
  could reuse `thread.updatedAt`, already persisted).
- **In-flight risk at plugin upgrade.** `ClaudeSession`/`ThreadSession` spawn a **real OS subprocess**
  (`pathToClaudeCodeExecutable`), independent of the Obsidian JS process — `onunload()` already has to tear
  these down today via `ThreadManager.destroy()`/`gracefulShutdown()` (`ThreadManager.ts:1445-1483`), and
  Stage 2 doesn't remove that necessity. What changes is **blast radius**: today, only threads with an
  in-flight turn hold a live subprocess at any given moment (`sessions`/`lingeringSessions` combined,
  typically small); under Stage 2, every thread the idle reaper hasn't yet reaped holds one, so an
  **ungraceful** reload (Obsidian force-quit, or a plugin disable that doesn't let `onunload()` finish)
  orphans proportionally more subprocesses. `gracefulShutdown()`'s existing pattern (fire `interrupt()` in
  parallel across all sessions, then poll for self-removal up to a 10s deadline, `:1445-1467`) generalizes
  directly to `ThreadSession.close()` calls without a design change, but the 10s budget should be
  re-verified against N-in-parallel drain latency once N is "however many active threads exist," not
  "however many have a turn in flight right now."
- **Mid-turn upgrade specifically:** a thread whose turn is in flight under the *old* per-turn model when
  new plugin code loads is not meaningfully different from today — Obsidian plugin code reloads happen at
  disable/enable boundaries, not via hot-swapping a running `ClaudeSession`/`ThreadSession` instance
  mid-call, so `onunload()`'s existing interrupt-then-close path is what governs this case both before and
  after Stage 2, unchanged.
- **Test surface — full rewrite, not patching:**
  - `test/unit/input-stream-lifecycle.test.ts` (527 lines) and `test/unit/thread-manager-lingering-sessions.test.ts`
    assert exactly the per-turn release-gate mechanics (`pendingBgTaskIds`, `sawTaskNotificationSinceLastResult`,
    `pendingInteractiveCallbacks`-as-a-gate, `endInput()`/`lingeringSessions`/`LINGER_MAX_MS`) that Stage 2
    deletes outright. Both need to be rewritten against the new `ThreadSession` contract; there's nothing to
    incrementally patch since the mechanism under test ceases to exist.
  - `test/unit/run-state-settled.test.ts` asserts `isRunning()`/settlement semantics tied to the two-map
    design — needs rework for the single-map, event-derived boolean.
  - `test/unit/session-message-handlers.test.ts`, `session-options.test.ts`, `capabilities-discovery.test.ts`,
    `mcp-elicitation.test.ts`, `plan-mode.test.ts`, `test/integration/plan-mode-persistence.test.ts`,
    `question-persistence.test.ts` test the `SessionCallbacks` contract and callback-driven message
    handling — these should largely **survive** if `ThreadSession` preserves `SessionCallbacks` verbatim
    (recommended), but their mock setup (currently mocking `ClaudeSession`'s constructor + one-shot `run()`
    signature, e.g. the pattern in `thread-manager-lingering-sessions.test.ts:38-75`) needs updating to
    `ThreadSession`'s `start()`/`send()` shape.
  - `test/unit/thread-manager.test.ts`, `test/integration/thread-manager-events.test.ts` touch the
    `sessions`/`lingeringSessions` maps directly in places — need targeted updates, not full rewrites.
  - `test/harness`/`test/screenshots/ui.spec.ts` drive UI state via fixtures, not live sessions — unaffected.

### 5. Testing strategy for Stage 2 itself

- **Unit:** `ThreadSession.send()` queuing behavior (multiple sends while a turn is in flight — including
  the exact scenario that's currently broken: a send arriving while a `canUseTool` request is pending on the
  live generation), `interrupt()` mapping, `restart()` reusing `resume`, idle-reaper timing (fake clock +
  pending-wake-up gating), `close()` graceful-drain-then-hard-close fallback.
- **Integration:** a regression test that reproduces `unwindLingeringSession`'s exact failure mode — a
  permission request in flight when a second message arrives for the same thread — and asserts the request
  resolves normally instead of the channel closing under it.

---

## Risks, tradeoffs, alternatives

### Risks

| Risk | Mitigation |
|---|---|
| Idle reaper picks a bad timeout — too short defeats the point (constant cold-starts on active threads), too long defeats the resource savings | Start from `LINGER_MAX_MS` (10 min), an already-chosen number in this codebase; treat as tunable, not fixed |
| No cap on concurrently-warm sessions — a user with dozens of active threads + cron wake-ups could accumulate many live subprocesses | Deferred by design (§3) pending real usage data; flagged as an explicit open question, not silently unbounded forever |
| `ThreadSession.send()`'s queuing semantics against a live generation are unverified against the real CLI (only `streamInput()`'s single-iterable-then-EOF contract is confirmed from source) | Must be probed against the live CLI before implementation — same "write a throwaway probe script first" discipline used for the original transport-error investigation (see `probe-stream-closed.ts` referenced in PR #298) |
| Larger blast radius on ungraceful shutdown (§4) | `gracefulShutdown()`'s existing parallel-interrupt-then-poll pattern generalizes directly; re-verify the timeout budget once N = active thread count, not in-flight-turn count |
| This is a substantially larger diff than Stage 1 (new class, deleted class, ~5 test files rewritten) — real regression surface during the rewrite itself | Land behind the same kind of phased rollout ADR-0001 used (§8 there) rather than one big-bang PR; see phasing note below |

### Alternatives considered

| Alternative | Assessment |
|---|---|
| **"Stage 1.5" — extend the generic guard to cover `unwindLingeringSession()` too** | Concretely: surface a `pendingInteractiveCallbacks`-equivalent from `ClaudeSession` to `ThreadManager` (e.g. a getter), gate `unwindLingeringSession()`'s `endInput()`/`close()` on it being zero, and decide what happens to the *new* message meanwhile (must be **queued**, not blocked — blocking `sendMessage()` indefinitely on a stuck human-approval elsewhere would itself hang the UI, which is its own bad outcome). This is real, scoped, and directly targets the diagnosed root cause of the post-07-16 regression. It would **not** require deleting `lingeringSessions`/`LINGER_MAX_MS`/the per-turn model — it's a patch, not a rewrite. **Recommended as an immediate stop-gap** (see Decision below) precisely because it's small and evidence-targeted, but it does not remove the structural cause: there would still be two `ClaudeSession` instances that *can* exist for one thread at overlapping times, with a queue instead of a fight between them. Every future feature that needs "start a new turn while an old one might still be draining" (cron wake-ups, `/loop`, orchestrator replies — all recent and growing) re-opens this same class of race in some new shape unless the one-Query-per-thread invariant is established. |
| **Keep focused-thread-only warm sessions** (only the active tab stays warm; others always cold-start) | Rejected — breaks scheduled/orchestrator wake-ups on unfocused threads (PR #310's whole point is threads doing work without the tab open) |
| **Global session cap with LRU eviction now** | Deferred, not designed — not enough usage data (11 active threads today) to size a cap without guessing; the idle reaper alone is the v1 control, revisit once Stage 2 ships and real concurrency is observed |
| **Do nothing further / rely on `transportErrorRecovery.ts`'s auto-retry** | Rejected as a standing position — auto-retry (`MAX_TRANSPORT_ERROR_AUTO_RETRIES = 1`) is explicitly a band-aid per its own doc comment ("We cannot fix the CLI binary itself..."); 962 errors in 5 days shows it isn't absorbing the volume |

### Recommendation

**Ship the Stage 1.5 patch first, as a fast, narrowly-targeted fix for the diagnosed `unwindLingeringSession()`
race, then proceed with the full Stage 2 rewrite.** The evidence for this ordering: the newly-identified
second root cause (§Context) is small, mechanical, and directly explains why errors continued after PR #298;
it's a multi-day fix, not a multi-week one, and it stops user-visible failures faster than waiting for the
full rewrite to land. But it should not be treated as sufficient on its own — it patches one specific
collision, not the "guess when it's safe to close stdin" premise that keeps producing new collisions as the
plugin grows more ways to start a turn (cron, `/loop`, orchestrator wake-ups, queued messages, and whatever
comes next). Stage 2 removes the premise. Do both, in that order.

### Open questions (need Rick's sign-off before implementation starts)

1. **Ship Stage 1.5 now, or go straight to Stage 2?** This ADR recommends both — 1.5 immediately as a
   stop-gap, Stage 2 after — but that's a scope/timeline call, not a purely technical one.
2. **Idle-reaper timeout:** reuse 10 min (`LINGER_MAX_MS`) as-is, or pick a different number now that its
   meaning changes from "safety cap on a stuck session" to "how long a thread stays warm doing nothing"?
3. **Hard cap on concurrently-warm `ThreadSession`s:** none for v1 (recommended), or set a conservative
   number now given cron/orchestrator threads can accumulate without a visible tab?
4. **`ThreadSession.send()`'s exact queuing contract against a live generation** needs to be probed against
   the real CLI before implementation locks in the design (see Risks table) — who owns writing that probe,
   and does it block starting the rewrite or run in parallel with early scaffolding?
5. **`session_state_changed` adoption:** confirmed available in the pinned SDK version (§1) but not
   currently consumed anywhere in the codebase. Should Stage 2 wire it in immediately as the authoritative
   busy/idle signal (replacing the event-derived `turnInFlight` boolean), or land Stage 2 first and adopt it
   as a fast-follow? The design leaves a single insertion point either way (one more `case` in the message-
   pump switch), so this is a scheduling question, not a design blocker.

---

## Consequences

**Easier:** no more guessing when it's safe to close stdin — there's one `Query` per thread and it closes
only when the thread's session is deliberately torn down; the `unwindLingeringSession()` race (and any
future variant of "a new turn starts while an old one might still be draining") is structurally impossible
rather than patched case-by-case; model/permission-mode changes become direct calls instead of full session
rebuilds; a large amount of bookkeeping (`lingeringSessions`, `lingerTimers`, `LINGER_MAX_MS`,
`pendingBgTaskIds`, `sawTaskNotificationSinceLastResult`) is deleted outright rather than grown.

**Harder:** the plugin now manages genuinely long-lived subprocess state instead of transient per-turn
state — idle-reaper correctness, shutdown blast radius, and eventual concurrent-session limits become real
operational concerns rather than edge cases; the rewrite touches a large, sensitive test surface
(`input-stream-lifecycle.test.ts`, `thread-manager-lingering-sessions.test.ts`, and the `isRunning()`/
settlement tests) that has been hardened against exactly the bugs this ADR is trying to fix, so the rewrite
risks reintroducing them in a new shape if not tested as carefully as the code it replaces.

**We're betting that:** the actual root cause of the residual "Stream closed" errors is architectural (a
per-turn session model fighting itself over a single thread's stdin), not a missing edge-case check, and
that removing the "which of two sessions owns this thread's stdin right now" question by construction is a
more durable fix than continuing to enumerate the ways two sessions can collide. The Stage 1.5 stop-gap is
the hedge in case that bet is wrong, or simply to buy time safely while Stage 2 is built and tested properly
rather than rushed.
