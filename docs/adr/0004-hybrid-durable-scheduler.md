# ADR-0004: Hybrid Durable Scheduler

**Date:** 2026-08-29
**Status:** Accepted

## Context

The scheduler armed each persisted deadline with one native `setTimeout`. A 30-day
interval is 2,592,000,000 ms, beyond JavaScript's signed 32-bit timer ceiling of
2,147,483,647 ms. Electron reduced that delay to approximately 1 ms, producing a
runaway fire/rearm loop.

Two durability races also remained. The asynchronous disk-based claim was not an
atomic renderer-wide claim, and post-fire bookkeeping wrote a stale whole-item
snapshot. An in-flight run could therefore overwrite a concurrent disable and
resurrect the job.

Constraints:

- The scheduler runs inside a bundled Electron renderer.
- `data.json` remains the durable store; adding Redis, MongoDB, or another service
  is out of scope.
- Plugin reloads can briefly overlap two scheduler generations.
- Reload reconciliation performs one catch-up attempt for an overdue recurring
  item, not one attempt per missed occurrence.
- The public `daily`, `weekly`, `interval`, and `once` schedule schema must remain
  backward compatible.

## Decision

Use a hybrid scheduler with `node-cron` pinned exactly to `4.2.1`.

- Daily and weekly calendar schedules use node-cron for local-time wake signals
  and its public next-run calculation. Returned calendar candidates are validated;
  an invalid or null candidate falls back to the existing local-time calculation.
- Persisted absolute `nextRun` remains canonical for every schedule type.
- Interval and one-shot deadlines use a heartbeat that caps every native timeout
  at 86,400,000 ms. An intermediate heartbeat rechecks `nextRun` and rearms; it
  never executes early.
- node-cron callbacks only request an occurrence through the same serialized fire
  path. They never create threads or send messages directly.
- A process-global `ScheduleCoordinator`, shared through `globalThis`, serializes
  create, update, delete, claim, authorize, abandon, and finalize mutations across
  overlapping plugin generations.
- Each item has an additive internal revision plus an explicit occurrence claim
  token, due time, and claim revision. This distinguishes one-shot claims even
  though their `nextRun` remains equal to `fireAt`.
- A successful claim is persisted before gates or external effects. After every
  asynchronous gate, the claim is re-authorized immediately before thread creation
  or message dispatch.
- Finalization merges completion fields into the coordinator's current item,
  preserving a concurrent disable or schedule edit. It never persists the stale
  fire-path snapshot or rearms that stale object.
- Disabling mutates the owning Scheduler's memory and cancels wake sources before
  its durable coordinated update completes. A dispatch that already started cannot
  be retracted, but its completion cannot re-enable or rearm the item.
- Internal fields are persisted for migration/durability but stripped from
  agent-facing `CronList` output.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Cap the existing timers only | Smallest diff; fixes the immediate overflow | Retains home-grown calendar wake logic and leaves claim/finalization races |
| Replace all scheduling with node-cron | One scheduling abstraction | Cron is calendar-oriented, not a durable fixed-interval/one-shot store; persistence and reload reconciliation remain application concerns |
| Hybrid node-cron + durable coordinator | Calendar-aware wakes, bounded timers, preserved public/persistence model | More internal state and coordination logic |
| Bree, Agenda, or BullMQ | Richer job infrastructure | Adds workers or external databases/queues that do not fit the renderer/data.json constraints |

## Consequences

- Public schedule fields and Cron tool inputs remain unchanged.
- Existing persisted items acquire internal revision/claim defaults lazily and stay
  readable without a destructive migration.
- Daily and weekly schedules retain local wall-clock behavior across DST.
- Active hours, deterministic gates, target-thread loops, wakeups, run history, and
  one-attempt startup catch-up all continue through the single authority path.
- The plugin guarantees a single claim across Scheduler instances in the same
  renderer. It does not claim OS-process-wide exactly-once delivery.
- Exactly-once delivery across a renderer crash between the durable claim and the
  external send is not guaranteed.

## Risks

- Separate OS processes do not share the global coordinator.
- node-cron's missed-run events must remain wake signals only; persisted `nextRun`
  reconciliation is authoritative and prevents replaying every missed occurrence.
- An already-started `sendMessage` cannot be cancelled. The enforceable guarantee
  is no dispatch after a disable is observed, no stale rearm, and no resurrection.
- node-cron 4.2.1 can return an invalid far-future weekday candidate from its public
  `getNextRun` walker. Candidate validation and the local-time fallback contain that
  package edge case without allowing its transient matcher state to become durable.
