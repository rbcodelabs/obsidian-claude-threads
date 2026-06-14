# Status Area Redesign — TODO

Based on: `Project & Hobbies/Brainstorm — Claude Threads Status Area Redesign — 2026-06-13.md`

## Requirements

- [x] **1. Kill `ct-status-bar`** — delete the flat italic text channel; nothing writes to it. Remove DOM element, CSS, and all write sites.

- [x] **2. Status rail** — typed status cards (blue active-work + spinner, amber warning, red error) replace the old text bar. Multiple states can coexist.

- [x] **3. Ephemeral toasts** — "⚡ Using X for this turn" and similar one-shots become 2-second auto-dismiss toasts, never blocking the rail.

- [x] **4. Queue rows (A1)** — stacked removable rows above the textarea, each with a × delete button and text preview (📎 suffix when images present). Collapses to "+N more" after 3 rows.

- [x] **5. Click row → pull into composer (B2)** — clicking a queue row body removes it from the queue and loads its text + images into the main DispatchInput. If the composer has content, shows an inline "Replace draft?" confirmation before overwriting.

- [x] **6. `ThreadManager` queue API** — add `getQueuedMessages(id)` returning the full `{text, images?}[]` array, and `removeQueuedMessageAt(id, index)` for deleting a specific item.

- [x] **7. Thinking spinner** — replace the italic `ct-thinking-label` with a CSS-animated spinner in both `ThreadsView.ts` and `MobileView.ts`.

- [x] **8. End-to-end verification of every requirement against the running system** — build the plugin, sideload into vault, and manually exercise: queue 3+ messages (rows render), delete one (×), click a row to pull back, trigger compaction/retry banners, trigger model-override ephemeral, observe thinking spinner.
