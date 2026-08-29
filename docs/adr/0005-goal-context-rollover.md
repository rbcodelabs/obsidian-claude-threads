# ADR-0005: Goal Changes Invalidate Live Session Context

**Date:** 2026-08-29
**Status:** Accepted

## Context

`/goal` persists text on a thread and includes it in the initialization prompt
built for a new Claude or Codex adapter. A warm adapter, however, keeps the
prompt it was started with. Sending a kickoff user message after changing the
stored goal therefore did not make that goal authoritative in the live session.

Neither harness exposes a verified API for mutating the system/developer prompt
of an active session. Closing an adapter during a turn, tool callback, permission
request, or background task can strand a result and corrupt conversation flow.
Goal replacement must also be last-write-wins when persistence or adapter resume
is slow.

## Decision

ThreadManager owns a desired and applied goal-context revision per thread.

- Setting, replacing, or clearing a goal increments the desired revision and
  cancels an older pending or starting kickoff.
- After the goal is persisted, the caller requests a revision-specific context
  refresh and, for a non-empty goal, exactly one kickoff.
- While persistence is pending, later user turns are held without refreshing.
  A failed save restores the prior goal/revision and releases those turns
  through the unchanged adapter.
- If an adapter is busy, awaiting an interactive callback, or has active
  background work, refresh waits. At the next safe boundary the old adapter is
  closed and removed.
- The replacement is created lazily through the normal session-options builder,
  preserving the provider session ID. Claude receives a rebuilt appended system
  prompt; Codex reapplies the same content as developer instructions on resume.
- The revision is checked again after adapter start/resume and after any
  pre-send preparation. A newer goal closes the obsolete adapter before its
  kickoff is recorded or sent.
- User turns submitted while context is invalid are held until the refreshed
  adapter is current. Delete and shutdown cancel pending goal work.
- A non-resumable/ephemeral thread starts a fresh adapter and uses the existing
  bounded canonical-history preamble. This preserves working context without
  pretending native session continuity exists.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Send the new goal only as a user kickoff | Minimal change | The old initialization prompt remains authoritative and can conflict with the new goal |
| Close and restart immediately | Applies the new prompt quickly | Can strand tool results, permissions, plans, questions, or background work |
| Safe deferred revisioned rollover | Authoritative context, continuity, last-write-wins | Adds per-thread lifecycle state and can delay kickoff until work settles |

## Consequences

Goal changes may not kick off immediately when a thread is busy, but existing
work is allowed to settle safely. The next generation runs through an adapter
built with only the latest goal. Clearing a goal sends no synthetic turn.

The design relies on provider resume semantics. When resume is unavailable, the
bounded history preamble is a deliberate degradation and may omit conversation
older than its cap.

## Risks

- A provider can change its resume behavior; adapter contract tests must keep
  verifying Claude appended prompts and Codex developer instructions.
- A background task that never resolves can defer rollover indefinitely; the
  existing background monitor's timeout/cleanup path is the release mechanism.
- Native resume failure can lose details outside the bounded history preamble.
