# ADR-0001: Structured Status-Line Tags & a Per-Thread Status-Line Service

**Date:** 2026-06-11
**Status:** Accepted

---

## Context

Each thread renders a context footer ("status line") of pills below the conversation.
Today **two independent mechanisms** feed that footer, and they overlap badly:

### Mechanism 1 — hard-coded `prUrl` regex scanners (to be removed)

The plugin scans **assistant message prose** for a GitHub PR URL and stashes it on `thread.prUrl`:

- `src/ThreadManager.ts:628-631` — on every assistant `onMessage`, runs
  `content.match(/https:\/\/github\.com\/[^\s>)"']+\/pull\/\d+/)` and sets `thread.prUrl`.
- `src/ThreadsView.ts:781-790` — when the footer renders, if `!thread.prUrl` it lazily
  re-scans the **last 20 assistant messages** for the same regex.

This is brittle and **misses the common case**: PRs are created with `gh pr create` inside a
**Bash tool call**, so the URL lands in tool *output*, not assistant prose. The scanner never sees it.

### Mechanism 2 — external status-line script (to be kept & extended)

`src/ThreadsView.ts:775-828` (`refreshStatusLine`) runs `settings.statusLineCommand` via
`child_process.exec`, pipes `{cwd, workspace:{current_dir}}` on stdin, takes stdout, and
`renderContextFooter` (`:830-892`) **splits on 2+ spaces** into segments. Each segment becomes a
pill, decorated by **heuristic icon rules**: `^https?://` → `globe`, `^PR #\d+` → `git-pull-request`,
`/AWS/` → `cloud`/`cloud-off` (warn if `expired`), else → `git-branch`. This is Claude Code's
statusline convention. The user's script (`~/claude-config/bin/statusline-command.sh`) already emits
`<dev-url>  <branch> PR #N  AWS ok|expired`. It runs **only for the focused thread**, on a `30_000ms`
interval (`STATUS_LINE_INTERVAL_MS`, `src/ThreadsView.ts:81`).

### Why consolidate

We want **one source of truth** for a thread's PR (and other context), sourced from the script —
which can read tool output's *effect* (the actual `gh pr view` for the branch) rather than guessing
from prose. But `prUrl` is consumed **across all threads**, while the script runs only for the focused
one. So consolidation requires moving script execution into a **per-thread polling service**.

### Decisions already made (designed around, not relitigated)

- **D1.** Output contract = JSON array of typed tags, with plaintext fallback. Trimmed stdout starting
  with `[` or `{` → parse as structured tags; otherwise → exact current plaintext behavior. Legacy
  plaintext is normalized into the same tag model so the renderer has **one path**.
- **D2.** Remove both `prUrl` regex scanners. `prUrl` becomes **derived** from the script's tags.
- **D3.** Per-thread polling service runs the script for **each** thread's cwd and stores tags +
  derived `prUrl` on every thread.

---

## Decision (summary)

1. Define a **typed tag model** (`StatusTag`) and a **parser** that accepts either structured JSON or
   legacy plaintext, normalizing both into `StatusTag[]`.
2. Introduce **`StatusLineService`** — a desktop-only singleton that polls the configured script for
   every thread's cwd on an interval + on key events, with PATH-fix env, timeout, concurrency cap,
   per-cwd coalescing/caching, and a mobile no-op.
3. Store results as **ephemeral** `thread.statusTags` and **derive** `thread.prUrl` from them.
4. **Delete** the two regex scanners (`ThreadManager.ts:628-631`, `ThreadsView.ts:781-790`).
5. The footer renders **generically** from `thread.statusTags`; all other `prUrl` consumers are
   **unchanged** because `prUrl` survives as a derived field.

---

## 1. The tag schema

```ts
/** One pill in a thread's status-line footer. */
export interface StatusTag {
  /** Required display text, e.g. "PR #42", "main", "AWS ok". */
  label: string;
  /** If set, the pill is a link (opened via electron shell.openExternal). */
  url?: string;
  /** Lucide icon name. If omitted, derived from `kind`/heuristics at parse time. */
  icon?: string;
  /** Visual tone. Defaults to 'normal'. */
  tone?: 'normal' | 'warn' | 'error';
  /**
   * Semantic category. 'pr' drives prUrl derivation and the leading PR pill.
   * Open-ended string so scripts can introduce new kinds without a plugin change.
   */
  kind?: 'pr' | 'branch' | 'dev' | 'aws' | string;
}
```

### Stdin contract

Unchanged shape, **plus** an added `branch` convenience field (the plugin already knows the cwd; it
does *not* compute git branch today, so `branch` is best-effort/optional and may be omitted — scripts
must keep deriving branch from `cwd` as the user's script does):

```jsonc
{ "cwd": "/abs/path", "workspace": { "current_dir": "/abs/path" }, "branch": "feat/x" }
```

Keeping `workspace.current_dir` preserves compatibility with stock Claude Code statusline scripts.

### Output detection rules (in the parser)

1. `text = stdout.trim()`. If empty → `[]` (footer hidden).
2. If `text[0] === '[' || text[0] === '{'`:
   - `JSON.parse`. If it's an array → treat as `StatusTag[]`. If it's an object with a `tags`
     array → use `obj.tags`. Coerce/validate each entry (drop entries with no `label`).
   - On **`JSON.parse` throw or shape mismatch → fall back to plaintext parsing** of the same text
     (defensive: a `[`-leading line that isn't valid JSON shouldn't blank the footer).
3. Else → **legacy plaintext path**: `text.split(/  +/)` → for each segment, build a `StatusTag` by
   applying the **exact current heuristics**:

| Segment matches | Resulting tag |
|---|---|
| `^https?://` | `{ label: seg, url: seg, icon: 'globe', kind: 'dev' }` |
| `^PR #\d+` | `{ label: seg, icon: 'git-pull-request', kind: 'pr' }` |
| `/AWS/` and includes `ok` | `{ label: seg, icon: 'cloud', kind: 'aws' }` |
| `/AWS/` and includes `expired` | `{ label: seg, icon: 'cloud-off', tone: 'warn', kind: 'aws' }` |
| `/AWS/` (other) | `{ label: seg, icon: 'cloud', kind: 'aws' }` |
| else | `{ label: seg, icon: 'git-branch', kind: 'branch' }` |

> Note the legacy script appends PR as `"<branch> PR #N"` in a **single** branch segment (no double
> space), so it currently renders as one `git-branch` pill. The legacy mapping preserves that exact
> (imperfect) behavior. Splitting branch/PR into separate tags is a **scripting** change, delivered
> via the new JSON reference script (§7), not a parser change.

### Icon resolution for structured tags

When a JSON tag omits `icon`, resolve from `kind`: `pr`→`git-pull-request`, `branch`→`git-branch`,
`dev`→`globe`, `aws`→`cloud` (or `cloud-off` if `tone` is `warn`/`error`), unknown→`tag`. Explicit
`icon` always wins. This keeps the renderer dumb (it just reads `tag.icon`).

### Concrete JSON examples

```json
[
  { "label": "http://localhost:3001", "url": "http://localhost:3001", "kind": "dev" },
  { "label": "feat/request-secret-tool", "kind": "branch" },
  { "label": "PR #221", "url": "https://github.com/rb/obsidian-claude-threads/pull/221", "kind": "pr" },
  { "label": "AWS expired", "tone": "warn", "kind": "aws" }
]
```

```json
{ "tags": [ { "label": "main", "kind": "branch" }, { "label": "AWS ok", "kind": "aws" } ] }
```

---

## 2. `prUrl` derivation rule

`prUrl` is derived from `statusTags` whenever the service stores a result:

```
derivePrUrl(tags) =
  first tag where  kind === 'pr' AND url is set        → tag.url
  else first tag where url matches /\/pull\/\d+/        → tag.url
  else undefined
```

**`prUrl` is sticky (upsert-only) — DECIDED.** A poll **only overwrites** `prUrl` when it yields a PR
tag; a poll with **no** PR tag leaves the existing `prUrl` untouched (it is never cleared on absence).
This keeps a thread matchable by the release archive-on-merge workflow after its PR merges and a live
`gh pr view` stops returning it. Note the deliberate divergence: `statusTags` (and therefore the
footer **PR pill**) reflect live reality and the pill *can* disappear after merge, while the stored
`prUrl` persists. The footer's synthesized-PR-pill path (§6) means the pill stays visible from
`prUrl` even when no live PR tag exists, so in practice the pill also persists. See migration (§6).

Both regex scanners are **deleted**:
- `src/ThreadManager.ts:628-631` (the `onMessage` scan) — removed entirely.
- `src/ThreadsView.ts:781-790` (the lazy 20-message rescan in `refreshStatusLine`) — removed; the
  service owns all `prUrl`/footer population.

---

## 3. `StatusLineService` design

A single instance owned by `main.ts`, constructed alongside `ThreadManager`.

### Responsibilities
- Run `settings.statusLineCommand` once **per thread cwd**, parse output to `StatusTag[]`, derive
  `prUrl`, write both onto each `Thread`, and emit an event so views refresh.
- Coalesce work by **cwd** (many threads share a cwd → one exec) and cache results briefly.

### Mobile no-op
First line of `start()` / `poll()`: `if (Platform.isMobile) return;` — `child_process` does not exist
on mobile. `thread.statusTags` simply stays `undefined`; the footer renders nothing and every consumer
treats `prUrl` as absent. Mirrors the existing `if (!Platform.isMobile)` guards at
`src/main.ts:77,132,138` and `src/SettingsTab.ts:404`.

### Env / PATH
Obsidian's `exec` runs with a minimal PATH (no `/opt/homebrew/bin`), so `gh`/`jq`/`git` silently fail.
**Reuse the existing pattern** in `src/dashboardUtils.ts:104-113` (`awsExecEnv`). Generalize it into a
shared `execEnv()` (prepends `/opt/homebrew/bin`, `/usr/local/bin`, `$HOME/.local/bin` to `PATH`, sets
`HOME`). Keep the existing `$HOME`/`~` command expansion from `ThreadsView.ts:807`.

### Triggers
- **Interval:** `setInterval` at `settings.statusLineIntervalMs` (default `30_000`, matching today's
  `STATUS_LINE_INTERVAL_MS`). One timer for the whole service, not one per thread.
- **Events** (via `ThreadManager.subscribe`, `src/ThreadManager.ts:816`): on `done`,
  `cwd_changed`, `thread_created`, `active_thread_changed` → schedule an immediate (debounced) poll
  for the affected thread's cwd. `done` is the key one — a PR is usually opened during a turn, so we
  refresh as soon as the turn ends instead of waiting up to 30s.

### Timeout / concurrency / debounce / caching
- **Timeout:** `5000ms` per exec (matches `ThreadsView.ts:811`); kill on timeout.
- **Concurrency cap:** at most **4** concurrent child processes; excess cwds queue.
- **Coalescing:** dedupe pending work by absolute cwd within a poll cycle — N threads on one cwd = one
  exec, result fanned out to all of them.
- **Cache:** per-cwd result cache with a short TTL (e.g. `5_000ms`) so an event-triggered poll right
  after an interval poll reuses the result instead of respawning.
- **Pause when idle:** if no `ThreadsView`, `KanbanView`, or `AgentDashboard` leaf is open, **and** no
  thread is running, skip interval polls (event-triggered polls still run so data is fresh when a view
  opens). Track view-open state via the existing leaf lifecycle, or simply gate on
  `app.workspace.getLeavesOfType(...)`.

### Storage of results & events
- Writes `thread.statusTags: StatusTag[]` and `thread.prUrl` (derived).
- Emits a new `ThreadManager` event `{ type: 'status_tags', threadId }` after each thread update so
  `ThreadsView`, `KanbanView`, `AgentDashboard` re-render via their existing `subscribe` handlers
  (`KanbanView.ts:53`, `AgentDashboard.ts:57`).

### Teardown
`stop()` clears the interval, the cache, aborts in-flight children, and unsubscribes. Called from
`main.ts`'s `onunload`. The service replaces `ThreadsView`'s
`startStatusLineInterval`/`stopStatusLineInterval`/`refreshStatusLine`
(`src/ThreadsView.ts:753-828`) — those are deleted; `ThreadsView` becomes a pure consumer that
re-renders from `thread.statusTags` on the `status_tags` event.

### Flow (one poll cycle)

```mermaid
sequenceDiagram
  participant T as Interval/Event
  participant S as StatusLineService
  participant E as exec(script, env=PATH-fixed)
  participant P as parseStatusLine
  participant M as ThreadManager
  participant V as Views (footer/kanban/dashboard)

  T->>S: tick / done / cwd_changed
  S->>S: collect threads, dedupe by cwd, check cache & mobile
  loop per unique cwd (cap 4 concurrent)
    S->>E: stdin {cwd,workspace,branch}, timeout 5s
    E-->>S: stdout (json | plaintext | empty)
    S->>P: parse -> StatusTag[]
    P-->>S: tags
    S->>S: derivePrUrl(tags); cache result
    S->>M: write statusTags + prUrl on each thread w/ that cwd
    S->>M: emit {type:'status_tags', threadId}
  end
  M-->>V: subscribe callback -> re-render pills from statusTags
```

---

## 4. Consumer migration table

Because `prUrl` survives as a **derived** field with the same shape, most consumers need **no change**.

| Consumer | File / line | Change |
|---|---|---|
| Assistant-prose PR scanner | `ThreadManager.ts:628-631` | **Removed** |
| Lazy 20-msg rescan + exec footer | `ThreadsView.ts:775-828` | **Removed**; replaced by service + event-driven re-render |
| `renderContextFooter` (PR pill + heuristic pills) | `ThreadsView.ts:830-892` | **Rewritten** to render generically from `StatusTag[]` (one pill per tag; PR-kind tag floats first). Heuristics move into the parser, not the renderer |
| Kanban PR chip | `KanbanView.ts:425-431` | **Unchanged** — still reads `thread.prUrl` |
| MCP `getCurrentThread` serialization | `main.ts:259` | **Unchanged** (`prUrl: t.prUrl`) |
| MCP `getAllThreads` serialization | `main.ts:271,289` | **Unchanged** |
| `obsidian_get_current_thread` / `obsidian_list_threads` output + descriptions | `ObsidianTools.ts:108,1000,1024` | **Unchanged behavior.** Optionally tweak the description: prUrl is now "the PR for this thread's branch, per the status-line script" rather than "most recent PR in assistant output" |
| AgentDashboard | `AgentDashboard.ts` | **Unchanged** for prUrl; re-renders on `status_tags` event like other events |
| Release archive-on-merge | `process/release.md:125`, `CLAUDE.md:23` | **Unchanged mechanism** (match `thread.prUrl` to shipped PR). Now *more reliable* because prUrl comes from `gh pr view` on the branch, not prose. Caveat: prUrl can go `undefined` after merge (§6) — see Risks |
| Architecture doc | `process/architecture.md:28` | Update the `prUrl` row to note it is derived from the status-line script + add a `statusTags` row |

Optionally surface `statusTags` in the MCP serializations later; out of scope for this ADR (prUrl
covers the cross-thread need today).

---

## 5. Data model & persistence changes

### Thread additions (`src/types.ts`, near `:111`)

```ts
/** Status-line pills for this thread, populated by StatusLineService. Ephemeral; re-derived each poll. */
statusTags?: StatusTag[];
// prUrl stays, but its doc-comment changes: now DERIVED from statusTags (a 'pr' tag or /pull/\d+ url).
```

### Persistence decision: **`statusTags` is ephemeral**
Not written to `data.json`. It is re-derived on the next poll, and is meaningless on mobile / when no
script is configured. Persisting it would create stale pills after restart and bloat `data.json`. The
service repopulates it within one interval (and immediately on the first event after load).

### `prUrl` persistence + migration
- `prUrl` **remains persisted** (it already is) so cross-thread consumers and the release workflow
  have a value immediately on load, before the first poll completes.
- **Migration:** none required to the schema. Existing persisted `prUrl` values are **kept as-is** on
  load (back-compat: threads whose scanners found a PR keep their pill). They get **overwritten** by
  the first successful poll for that cwd. On desktop with a script configured, reality wins. If no
  script is configured or on mobile, the old persisted value is simply retained and rendered (the
  footer's PR pill still works from `prUrl` even with zero tags — see §6 renderer note).

---

## 6. Renderer note (generic footer)

`renderContextFooter` becomes:

1. If `thread.prUrl` is set but **no** `kind:'pr'` tag exists (e.g. legacy persisted prUrl, or
   script not configured), synthesize a leading PR pill from `prUrl` (preserves today's "PR pill
   always first" behavior and the no-script-but-have-prUrl path at `ThreadsView.ts:795,815`).
2. Render one pill per `StatusTag`: icon from `tag.icon` (resolved per §1), label `tag.label`, link
   if `tag.url` (electron `shell.openExternal`, as today at `:843-847`), tone class for `warn`/`error`
   (`ct-footer-pill-warn` already exists at `:876`; add `ct-footer-pill-error`).
3. Hide the footer iff no prUrl **and** no tags (mirrors `:887`).

This collapses the special-cased PR-pill + heuristic-pill branches into **one loop over the model**.

---

## 7. Settings & UX

- `settings.statusLineCommand` — **kept**, unchanged semantics. Stock plaintext Claude Code statusline
  scripts keep working via the fallback path.
- **New** `settings.statusLineIntervalMs` (optional, default `30_000`) so power users with many
  threads can lengthen the interval. Wire into the service's timer; changing it restarts the timer
  (the existing `updateStatusLineCommand`, `ThreadsView.ts:894`, becomes a call into the service).
- Settings tab help text: document the JSON contract and link to the reference script. Note it is
  **desktop-only**.

### Reference JSON script (ships in docs; port of the user's bash script)

Emits a JSON array with split branch/PR/dev/AWS tags and a real PR **url** (so `prUrl` derivation
works without prose scanning):

```bash
#!/usr/bin/env bash
input=$(cat)
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')

branch=""; remote=""
if [ -n "$cwd" ]; then
  branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
  remote=$(git -C "$cwd" --no-optional-locks remote get-url origin 2>/dev/null)
fi

# Build a JSON array of tags with jq (handles escaping).
tags='[]'
add() { tags=$(jq -c --argjson t "$1" '. + [$t]' <<<"$tags"); }

# dev url (nextdev port lookup, alive check)
if [ -n "$cwd" ]; then
  abs_cwd=$(cd "$cwd" && pwd -P 2>/dev/null)
  if [ -n "$abs_cwd" ]; then
    hash=$(printf '%s' "$abs_cwd" | shasum | cut -c1-12)
    sd="${XDG_STATE_HOME:-$HOME/.local/state}/nextdev/$hash"
    if [ -f "$sd/port" ] && [ -f "$sd/pid" ]; then
      pid=$(cat "$sd/pid"); port=$(cat "$sd/port")
      if kill -0 "$pid" 2>/dev/null; then
        add "$(jq -nc --arg u "http://localhost:$port" '{label:$u,url:$u,kind:"dev"}')"
      fi
    fi
  fi
fi

# branch
[ -n "$branch" ] && add "$(jq -nc --arg b "$branch" '{label:$b,kind:"branch"}')"

# PR for branch — emit url so prUrl derives correctly
if [ -n "$branch" ] && [ -n "$remote" ]; then
  pr_json=$(gh pr view "$branch" --repo "$remote" --json number,url 2>/dev/null)
  if [ -n "$pr_json" ]; then
    n=$(jq -r '.number' <<<"$pr_json"); u=$(jq -r '.url' <<<"$pr_json")
    add "$(jq -nc --arg l "PR #$n" --arg u "$u" '{label:$l,url:$u,kind:"pr"}')"
  fi
fi

# AWS SSO status with tone
if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity --query Account --output text >/dev/null 2>&1; then
    add "$(jq -nc '{label:"AWS ok",kind:"aws"}')"
  else
    add "$(jq -nc '{label:"AWS expired",tone:"warn",kind:"aws"}')"
  fi
fi

printf '%s' "$tags"
```

---

## 8. Back-compat & rollout

Plaintext scripts (including any stock Claude Code statusline) keep working untouched — the parser's
fallback path reproduces today's exact rendering.

| Phase | Scope | Verifiable outcome |
|---|---|---|
| **1** | `StatusLineService` + `parseStatusLine` + `derivePrUrl`; remove both scanners; service writes `statusTags`+`prUrl`; mobile no-op; PATH env | `prUrl` populates for branches with a PR via the script; scanners gone; unit tests green |
| **2** | Footer renders generically from `statusTags` (§6); delete `ThreadsView` exec/interval/rescan; tone classes | Footer pills match prior look on plaintext scripts; structured scripts render typed pills; screenshot tests updated |
| **3** | Ship reference JSON script + settings help + `statusLineIntervalMs`; update `process/architecture.md`, `process/release.md` notes | Docs shipped; example script produces a clickable PR pill end-to-end |

Phases 1–2 can land together; Phase 3 is docs/settings only. No data migration gates any phase.

---

## 9. Testing strategy

**Unit (parser & derivation)** — pure functions, no Obsidian:
- `parseStatusLine`: valid JSON array; `{tags:[...]}` object form; **malformed** JSON starting with
  `[` falls back to plaintext (not blank); empty stdout → `[]`; entries missing `label` dropped.
- Legacy heuristic mapping: each row of the §1 table (url→globe, `PR #N`→pull-request, AWS ok/expired
  tone, default branch) and the `split(/  +/)` segmentation.
- `derivePrUrl`: `kind:'pr'` with url wins; `/pull/\d+` url fallback; no PR tag → `undefined`;
  multiple PR tags → first.
- Icon resolution from `kind` when `icon` omitted; explicit `icon` wins.

**Service-logic (mockable)** — inject a fake `exec`, fake clock, fake `Platform`:
- Mobile → `poll()` is a no-op, no exec, `statusTags` stays undefined.
- cwd coalescing: 3 threads on one cwd → 1 exec, all 3 updated.
- Concurrency cap respected (≤4 in flight); excess queued.
- Cache TTL: event right after interval reuses cached result (no second exec).
- Timeout path: hung child killed at 5s, footer unaffected.
- `execEnv()` prepends the homebrew/local bin dirs (assert on PATH).

**Screenshot (`test/screenshots/ui.spec.ts`)** — the footer lives in `ThreadsView`, which **is**
mounted in the main harness (`test/harness/`, `index.ts`). Add fixtures driving `thread.statusTags`:
a JSON-tag thread (dev/branch/PR/AWS-warn pills) and a legacy-plaintext thread, asserting pill
icons/labels/tone render identically to today for the plaintext case and correctly for the JSON case.
Drive via harness fixtures (`test/harness/fixtures.ts`) rather than a live exec (deterministic, no
subprocess).

---

## 10. Risks, tradeoffs, alternatives

### Risks
| Risk | Mitigation |
|---|---|
| `prUrl` flips to `undefined` after a PR merges (script no longer finds it), breaking release archive-on-merge matching | **Resolved by the sticky decision (§2):** `prUrl` is upsert-only and never cleared on absence, so a merged PR stays matchable indefinitely. The footer also synthesizes its PR pill from the sticky `prUrl` (§6), so the visible pill persists too |
| N threads × shell spawns = cost/IO | Coalesce by cwd, cap 4 concurrent, cache TTL, pause when no view open & nothing running |
| Script hangs (e.g. `gh` auth prompt) | 5s timeout + kill; cap prevents pileup |
| User script assumes a login shell PATH | `execEnv()` prepends homebrew/local bins; document the contract |
| Malformed JSON blanks footers | Parser falls back to plaintext on parse error rather than emptying |

### Alternatives considered (rejected)
| Alternative | Why rejected |
|---|---|
| **Keep focused-thread-only execution** (status line only for the active thread) | `prUrl` is consumed across *all* threads (Kanban chips, MCP `getAllThreads`, release workflow). Focused-only can't populate them → defeats consolidation. **Rejected** (D3) |
| **Built-in `gh` resolver** (plugin shells `gh pr view` directly, no user script) | Hard-codes a GitHub/`gh` assumption into the plugin, can't express dev-url/AWS/other context, and reintroduces a second mechanism. The whole point of D1/D3 is one extensible script-driven path. **Rejected** |
| **Persist `statusTags` in data.json** | Stale pills after restart, data.json bloat, meaningless on mobile/no-script. Re-derivable cheaply. **Rejected** — kept ephemeral |
| **Keep regex scanners as a fallback** | Defeats D2, keeps the brittle prose-only path, and the common Bash-tool-output case still missed. **Rejected** |

### Resolved decisions
1. **Sticky vs. live `prUrl`? → STICKY (decided).** A poll with no PR tag does **not** clear `prUrl`;
   only a poll that yields a PR tag overwrites it. Merged PRs stay matchable by the release workflow.
   `statusTags` still reflect live reality, but the footer keeps a synthesized PR pill from the sticky
   `prUrl` (§6), so the pill persists too. The §10 risk row for prUrl-flips-to-undefined is thereby
   neutralized.

### Open questions (deferred, with v1 defaults)
2. Should `statusTags` be exposed in MCP `obsidian_list_threads` output now, or deferred? **Deferred**
   unless agents need non-PR context cross-thread.
3. Should the interval setting be global or per-project? **Global** for v1.

---

## Consequences

**Easier:** one rendering path; reliable PR detection (branch-based, not prose); extensible context
(any `kind`); cross-thread `prUrl` populated uniformly.
**Harder:** a real background service to own (lifecycle, cost, teardown) instead of one focused exec.
**We're betting that:** script-driven, branch-based PR resolution is strictly more reliable than prose
regex, and that per-thread polling cost is acceptable under coalescing + caps + idle-pause.
