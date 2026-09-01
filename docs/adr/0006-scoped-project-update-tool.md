# ADR-0006: Scope Agent-Initiated Project Configuration Updates

**Date:** 2026-08-31
**Status:** Accepted

## Context

Project name, context, and working-directory settings were editable only through
the Settings UI. Agents could create Projects and assign threads, but could not
durably correct an existing Project configuration. Direct edits to plugin data
also race the running settings manager and can be overwritten.

Project membership is a coordination boundary, not a filesystem security
boundary. The Portfolio Orchestrator already uses explicit per-call Project
elevation for Project-scoped coordination.

## Decision

Expose `threads_update_project`, with `obsidian_update_project` retained as its
deprecated compatibility alias.

- Project members and Project orchestrators may update their own Project.
- Unassigned and cross-Project callers are denied before Project lookup.
- The Portfolio Orchestrator must provide `elevatedProjectId` matching the
  target Project.
- The editable surface is limited to `name`, `description`, and `cwdOverride`.
  Identity, vault folder, creation time, and orchestrator ownership are not
  agent-editable.
- Omitted fields are preserved. `null` clears description or cwd override.
- The host awaits atomic settings persistence before returning the updated
  snapshot and restores the prior in-memory values if persistence fails.
  A single plugin-wide callback serializes update transactions across every
  thread, so rollback cannot overwrite another agent update. Rollback restores
  only fields changed by the failed tool call and only while they still contain
  that call's applied value, preserving later Settings UI edits. Patches that do
  not change current values are rejected before mutation or persistence.
- Existing threads and live sessions are not relocated or restarted. Future
  Project dispatches and dynamic schedules resolve the updated cwd.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Keep updates UI-only | No new mutation API | Agents cannot repair configuration; automation remains blocked |
| Allow unrestricted full-Project replacement | Simple generic API | Exposes identity, routing, and ownership fields unnecessarily |
| Scoped partial update | Small capability surface; follows coordination policy; durable result | Requires explicit null/omission semantics and rollback |

## Consequences

Agents can safely maintain the Project settings needed for their work without
editing plugin storage directly. A successful tool result means the change was
persisted. Context changes become visible to newly initialized sessions but do
not rewrite an already-running session prompt.

Automatic path-disambiguation injection is intentionally separate from this
configuration API.

## Risks

- Project members are trusted to change shared Project configuration for their
  own Project.
- Cwd changes can redirect future Project work, so authorization must remain
  centralized and must run before target lookup.
- A failed save causes a second in-memory change notification during rollback;
  consumers must treat the final manager state as authoritative.
