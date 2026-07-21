import type { Thread, ChatMessage, Project } from '../../src/types';

// Timestamps: Thread 1 most recent (active by default), Thread 3 oldest.
// Pinned to a fixed wall-clock time so screenshot baselines are stable
// across runs — never use Date.now() here.
const EPOCH = new Date('2026-01-15T10:00:00Z').getTime();
const T1 = EPOCH - 5 * 60 * 1000;      // 9:55 AM UTC
const T2 = EPOCH - 45 * 60 * 1000;     // 9:15 AM UTC
const T3 = EPOCH - 2 * 60 * 60 * 1000; // 8:00 AM UTC

// ─── Thread 1: Fix auth middleware ───────────────────────────────────────────

const thread1Messages: ChatMessage[] = [
  {
    id: 'msg-t1-1',
    role: 'user',
    content: 'The auth middleware is throwing 401s in staging but not locally. Can you take a look?',
    timestamp: T1 + 0,
  },
  {
    id: 'msg-t1-2',
    role: 'assistant',
    content: `I found the issue. The \`JWT_SECRET\` environment variable isn't set in staging, causing token verification to fail silently.

**Root cause** in \`src/middleware/auth.ts\`:

\`\`\`typescript
// Before (broken — falls back to empty string, always invalid)
const secret = process.env.JWT_SECRET || '';
const decoded = jwt.verify(token, secret); // never throws, always fails

// After (correct — fail fast on startup)
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is not set');
const decoded = jwt.verify(token, secret);
\`\`\`

The empty-string fallback means \`jwt.verify\` runs with \`''\` as the secret, which always produces an invalid signature error — exactly what you're seeing as 401s.

**Fix:** Add \`JWT_SECRET\` to your Vercel staging environment variables:
1. Go to your Vercel project → Settings → Environment Variables
2. Add \`JWT_SECRET\` with a strong random value (e.g., \`openssl rand -base64 32\`)
3. Make sure it's scoped to the **Preview** environment
4. Redeploy to pick up the new variable`,
    timestamp: T1 + 90000,
    toolCalls: [
      { name: 'Read', summary: 'Read: src/middleware/auth.ts' },
      { name: 'Read', summary: 'Read: .env.example' },
    ],
    cost: 0.0023,
    summary: 'Found JWT_SECRET missing in staging; fixed auth.ts to fail fast and documented the Vercel env var steps.',
  },
  {
    id: 'msg-t1-3',
    role: 'user',
    content: 'Perfect. Can you also add a test for this?',
    timestamp: T1 + 3 * 60 * 1000,
  },
  {
    id: 'msg-t1-4',
    role: 'assistant',
    content: `Added a test suite in \`src/middleware/__tests__/auth.test.ts\`:

\`\`\`typescript
import { verifyAuth } from '../auth';

describe('auth middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws on startup when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    expect(() => verifyAuth('any-token')).toThrow('JWT_SECRET is not set');
  });

  it('returns decoded payload for a valid token', () => {
    process.env.JWT_SECRET = 'test-secret-do-not-use';
    const token = jwt.sign({ userId: 42 }, 'test-secret-do-not-use');
    const result = verifyAuth(token);
    expect(result.userId).toBe(42);
  });

  it('throws for an invalid token', () => {
    process.env.JWT_SECRET = 'test-secret-do-not-use';
    expect(() => verifyAuth('bad.token.here')).toThrow();
  });
});
\`\`\`

Run with \`npm test -- --testPathPattern=auth\` to verify. All three cases should pass once you apply the fix from the previous message.`,
    timestamp: T1 + 5 * 60 * 1000,
    toolCalls: [
      { name: 'Write', summary: 'Write: src/middleware/__tests__/auth.test.ts' },
      { name: 'Edit', summary: 'Edit: src/middleware/auth.ts' },
    ],
    cost: 0.0041,
    summary: 'Added three-case Jest test suite for auth middleware covering missing secret, valid token, and invalid token.',
  },
  {
    id: 'msg-t1-5',
    role: 'user',
    content: 'Can you show me what the logo looks like?',
    timestamp: T1 + 6 * 60 * 1000,
  },
  {
    id: 'msg-t1-6',
    role: 'assistant',
    content: 'Here is the logo file:',
    timestamp: T1 + 7 * 60 * 1000,
    toolCalls: [
      { name: 'Read', summary: 'Read: assets/logo.png' },
    ],
    toolResultImages: [
      // 4×4 teal PNG — minimal valid image for screenshot fixture
      { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR4nGNgaGhAIOI4AJhDEAHnXAP7AAAAAElFTkSuQmCC' },
    ],
    cost: 0.0008,
    summary: 'Displayed the logo PNG inline.',
  },
];

// ─── Thread 2: HipTrip feature brainstorm ────────────────────────────────────

const thread2Messages: ChatMessage[] = [
  {
    id: 'msg-t2-1',
    role: 'user',
    content: '/brainstorm What are some ways we could make trip planning more social?',
    timestamp: T2 + 0,
  },
  {
    id: 'msg-t2-2',
    role: 'assistant',
    content: `Here are some high-leverage ideas for making HipTrip more social, ranked by impact/effort:

| Feature | Impact | Effort |
|---|---|---|
| **Trip co-planning** — shared drafts with real-time cursors (like Figma for itineraries) | High | High |
| **"Going too?" social layer** — see which friends have saved the same destination, nudge to coordinate | High | Medium |
| **Public trip reviews** — after a trip, publish a structured recap with places rated by vibe, not stars | Medium | Low |
| **Curated packs** — let power users publish themed trip packs (e.g., "Best 48h in Lisbon for jazz lovers") | High | Medium |

**My top pick:** the social-layer nudge feature. It has a viral loop (you see a friend's saved destination → you reach out → they invite you → you both have a better trip → you both post recaps) with relatively low infrastructure cost since you're just indexing existing saves.

The co-planning feature is the most ambitious but could be a real differentiator — no one does async collaborative itinerary editing well right now.`,
    timestamp: T2 + 60000,
    summary: 'Proposed four social features for HipTrip; recommended the "Going too?" destination-matching nudge as the best impact/effort pick.',
  },
];

// ─── Thread 3: Empty / freshly created ───────────────────────────────────────

const thread3Messages: ChatMessage[] = [];

// ─── Thread 4: Agentic run — consecutive assistant messages ──────────────────
// Used by compress-view screenshot tests: grouping consecutive assistant
// messages into a single collapsible block requires 2+ in a row.

const thread4Messages: ChatMessage[] = [
  {
    id: 'msg-t4-1',
    role: 'user',
    content: 'Refactor the database module to use connection pooling.',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t4-2',
    role: 'assistant',
    content: `Starting the refactor. Let me read the current implementation first.`,
    timestamp: T3 + 10000,
    toolCalls: [
      { name: 'Read', summary: 'Read: src/db/index.ts' },
      { name: 'Read', summary: 'Read: src/db/queries.ts' },
    ],
    summary: 'Read the database module to understand the current implementation.',
  },
  {
    id: 'msg-t4-3',
    role: 'assistant',
    content: `The current module opens a new connection per query. I'll replace it with a \`pg.Pool\` and update all callers.`,
    timestamp: T3 + 25000,
    toolCalls: [
      { name: 'Edit', summary: 'Edit: src/db/index.ts — replace Client with Pool' },
      { name: 'Edit', summary: 'Edit: src/db/queries.ts — use pool.query()' },
    ],
    summary: 'Replaced per-query Client with a shared Pool; updated all query callers.',
  },
  {
    id: 'msg-t4-4',
    role: 'assistant',
    content: `Done! Here's what changed:

- **\`src/db/index.ts\`** — exports a singleton \`Pool\` instead of a factory function. Pool size defaults to 10; configurable via \`DB_POOL_SIZE\` env var.
- **\`src/db/queries.ts\`** — all functions now call \`pool.query()\` directly instead of creating and destroying a \`Client\` per call.

Idle connections are released after 30 s. Run \`npm test\` — all existing DB tests should still pass since the query API is unchanged.`,
    timestamp: T3 + 40000,
    cost: 0.0031,
    summary: 'Completed connection-pool refactor; documented changes and next steps.',
  },
];

// ─── Thread 5: Wikilink rendering ────────────────────────────────────────────
// Used by the wikilink-rendering screenshot test to verify that [[wikilinks]]
// in assistant messages render as clickable internal links, not raw text.

const thread5Messages: ChatMessage[] = [
  {
    id: 'msg-t5-1',
    role: 'user',
    content: 'Where did we put the golden wealth research?',
    timestamp: T3 + 0,
  },
  {
    id: 'msg-t5-2',
    role: 'assistant',
    content: `The research is saved in your vault. Here are the relevant notes:

- [[Claude/golden-wealth-amplify-teardown-2026-06-06]] — full teardown with recommendations
- [[Projects/HipTrip/Market Research]] — supporting competitive context
- See also [[Daily/2026-06-06|today's daily note]] for the session link

You can open any of them directly from here.`,
    timestamp: T3 + 15000,
    cost: 0.0008,
    summary: 'Pointed to three relevant vault notes using Obsidian wikilinks.',
  },
];

// ─── Exported fixtures ────────────────────────────────────────────────────────

export const fixtureThreads: Thread[] = [
  {
    id: 'thread-fix-auth',
    title: 'Fix auth middleware',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread1Messages,
    createdAt: T1,
    updatedAt: T1 + 5 * 60 * 1000,
    summary: 'Debugged 401s in staging caused by a missing JWT_SECRET env var. Fixed auth.ts to throw on startup rather than silently fall back to an empty string. Added Jest tests covering the missing-secret, valid-token, and invalid-token cases.',
    recap: 'Read auth.ts and .env.example, then wrote a test file and edited the middleware.',
    editedFiles: [
      '/Users/mock/projects/hip-trip/src/middleware/auth.ts',
      '/Users/mock/projects/hip-trip/src/middleware/__tests__/auth.test.ts',
    ],
  },
  {
    id: 'thread-brainstorm',
    title: 'HipTrip feature ideas',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread2Messages,
    createdAt: T2,
    updatedAt: T2 + 60000,
  },
  {
    id: 'thread-new',
    title: 'Thread 3',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread3Messages,
    createdAt: T3,
    updatedAt: T3,
  },
  {
    id: 'thread-agentic',
    title: 'DB connection pooling refactor',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread4Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 40000,
  },
  {
    id: 'thread-wikilinks',
    title: 'Wikilink rendering test',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread5Messages,
    createdAt: T3 - 120000,
    updatedAt: T3 + 15000,
  },
  {
    id: 'thread-tasks',
    title: 'Hip provenance initiative',
    cwd: '/Users/mock/projects/hip-trip',
    messages: thread1Messages,
    createdAt: T3 - 60000,
    updatedAt: T3 + 30000,
    tasks: [
      { id: '1', content: 'Write discerning-traveler initiative doc (ideas + design direction)', status: 'completed' },
      { id: '2', content: 'Implement Hip Provenance — "why this place" editorial layer in itinerary view', status: 'completed' },
      { id: '3', content: 'Enhance locked preview with curation quality signals', status: 'completed' },
      { id: '4', content: 'Add hip context to public share view (/i/[slug])', status: 'completed' },
      { id: '5', content: 'Verify: types, unit tests, build, visual check', status: 'in_progress' },
    ],
  },
];

// ─── Kanban board fixtures ────────────────────────────────────────────────────
// A dedicated fixture set for the Kanban harness (test/harness/kanban-index.ts).
// Kept separate from `fixtureThreads` so the conversation-view snapshots don't
// churn. Designed to populate every status column AND span multiple folders so
// both the status board and the folder-swimlane layout render meaningfully.
//
// Folder grouping resolves to: assigned Project name → working-directory label
// → "Unassigned". These fixtures cover all three:
//   • HipTrip       (project)   — Working, Awaiting, New, Done
//   • Claude Threads (project)  — New, Failed, Ready
//   • acme-api      (cwd only)  — Done
//   • Unassigned    (no cwd)    — New
//
// Running / Awaiting state is not stored on the Thread — it lives in the
// ThreadManager's private session/permission maps. kanban-index.ts seeds those
// maps for `k-hiptrip-running` and `k-hiptrip-awaiting` so those two land in
// the Working and Awaiting columns respectively.

const KT = EPOCH; // kanban fixtures anchor to the same pinned epoch

const userMsg = (id: string, content: string, ts: number): ChatMessage => ({ id, role: 'user', content, timestamp: ts });
const asstMsg = (id: string, content: string, ts: number, summary?: string): ChatMessage => ({
  id, role: 'assistant', content, timestamp: ts, summary,
});

export const kanbanFixtureProjects: Project[] = [
  { id: 'proj-hiptrip', name: 'HipTrip', vaultFolder: 'Projects/HipTrip', createdAt: KT - 7 * 24 * 60 * 60 * 1000 },
  { id: 'proj-threads', name: 'Claude Threads', vaultFolder: 'Projects/ClaudeThreads', createdAt: KT - 5 * 24 * 60 * 60 * 1000 },
];

// Thread ids whose running / pending-permission state the harness must seed.
export const kanbanRunningThreadId = 'k-hiptrip-running';
export const kanbanAwaitingThreadId = 'k-hiptrip-awaiting';
export const kanbanAwaitingPermission = { toolName: 'Bash', detail: 'npm run deploy --prod' };
export const kanbanRunningActivity = 'Editing src/itinerary/PlaceCard.tsx';

// Thread with a pending ScheduleWakeup, seeded (not running) — exercises the
// Kanban "Waiting" column added in fix/scheduled-wakeup-visibility.
export const kanbanWaitingThreadId = 'k-hiptrip-waiting';
export const kanbanWaitingFireAt = KT + 4 * 60 * 1000; // 4 minutes from the pinned clock
export const kanbanWaitingReason = 'check CI status';

export const kanbanFixtureThreads: Thread[] = [
  // ── HipTrip lane (most-recent activity → top lane) ──────────────────────────
  {
    id: kanbanRunningThreadId,
    title: 'Add "why this place" provenance layer',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [userMsg('k1', 'Add an editorial provenance layer to the itinerary card.', KT - 60_000)],
    createdAt: KT - 60_000,
    updatedAt: KT - 30_000,
    editedFiles: ['/Users/mock/projects/hip-trip/src/itinerary/PlaceCard.tsx'],
  },
  {
    id: kanbanAwaitingThreadId,
    title: 'Deploy curation quality signals',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [userMsg('k2', 'Ship the curation-quality changes to prod.', KT - 4 * 60_000)],
    createdAt: KT - 4 * 60_000,
    updatedAt: KT - 90_000,
  },
  {
    id: kanbanWaitingThreadId,
    title: 'Auto-retry flaky preview deploys',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [userMsg('k-wait-1', 'Watch the preview deploy and retry once if it flakes.', KT - 2 * 60_000)],
    createdAt: KT - 2 * 60_000,
    updatedAt: KT - 60_000,
  },
  {
    id: 'k-hiptrip-new',
    title: 'Social "Going too?" nudge',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [
      userMsg('k3', 'Sketch the destination-matching nudge.', KT - 20 * 60_000),
      asstMsg('k4', 'Proposed an index over existing saves with a low-cost viral loop.', KT - 19 * 60_000,
        'Proposed the "Going too?" destination-matching nudge built on existing saves.'),
    ],
    createdAt: KT - 20 * 60_000,
    updatedAt: KT - 19 * 60_000,
    summary: 'Proposed the "Going too?" destination-matching nudge built on existing saves.',
    reviewed: false,
  },
  {
    id: 'k-hiptrip-done',
    title: 'Fix auth middleware 401s',
    cwd: '/Users/mock/projects/hip-trip',
    projectId: 'proj-hiptrip',
    messages: [
      userMsg('k5', 'Auth middleware throws 401s in staging.', KT - 60 * 60_000),
      asstMsg('k6', 'Fixed: JWT_SECRET was missing; auth.ts now fails fast on startup.', KT - 59 * 60_000,
        'Fixed missing JWT_SECRET in staging; auth.ts now fails fast.'),
    ],
    createdAt: KT - 60 * 60_000,
    updatedAt: KT - 59 * 60_000,
    summary: 'Fixed missing JWT_SECRET in staging; auth.ts now fails fast.',
    reviewed: true,
    prUrl: 'https://github.com/acme/hip-trip/pull/482',
    editedFiles: ['/Users/mock/projects/hip-trip/src/middleware/auth.ts'],
  },

  // ── Claude Threads lane ─────────────────────────────────────────────────────
  {
    id: 'k-threads-new',
    title: 'Kanban folder swimlanes',
    cwd: '/Users/mock/projects/obsidian-claude-threads',
    projectId: 'proj-threads',
    messages: [
      userMsg('k7', 'Group the kanban board by working folder.', KT - 40 * 60_000),
      asstMsg('k8', 'Added a Group by: Status / Folder toggle rendering folder swimlanes.', KT - 39 * 60_000,
        'Added folder-swimlane grouping to the Kanban board.'),
    ],
    createdAt: KT - 40 * 60_000,
    updatedAt: KT - 39 * 60_000,
    summary: 'Added folder-swimlane grouping to the Kanban board.',
    reviewed: false,
  },
  {
    id: 'k-threads-failed',
    title: 'Relay reconnect backoff',
    cwd: '/Users/mock/projects/obsidian-claude-threads',
    projectId: 'proj-threads',
    messages: [userMsg('k9', 'The relay client never reconnects after a drop.', KT - 80 * 60_000)],
    createdAt: KT - 80 * 60_000,
    updatedAt: KT - 79 * 60_000,
    lastError: 'WebSocket closed (1006) — exhausted reconnect attempts',
  },
  {
    id: 'k-threads-ready',
    title: 'Mobile layout polish',
    cwd: '/Users/mock/projects/obsidian-claude-threads',
    projectId: 'proj-threads',
    messages: [],
    createdAt: KT - 100 * 60_000,
    updatedAt: KT - 100 * 60_000,
  },

  // ── acme-api lane (no project → working-directory label) ────────────────────
  {
    id: 'k-acme-tasks',
    title: 'Migrate auth tokens to short-lived JWTs',
    cwd: '/Users/mock/projects/acme-api',
    messages: [
      userMsg('k14', 'Migrate legacy API keys to short-lived JWTs.', KT - 2 * 60 * 60_000),
      asstMsg('k15', 'Working on it — 3 of 5 steps done.', KT - 2 * 60 * 60_000 + 30_000,
        'Migrating to short-lived JWTs — 3 of 5 steps done.'),
    ],
    createdAt: KT - 2 * 60 * 60_000,
    updatedAt: KT - 2 * 60 * 60_000 + 30_000,
    summary: 'Migrating to short-lived JWTs — 3 of 5 steps done.',
    tasks: [
      { id: 't1', content: 'Add JWT signing key to secrets manager', status: 'completed' },
      { id: 't2', content: 'Implement token generation in AuthService', status: 'completed' },
      { id: 't3', content: 'Update middleware to verify JWTs', status: 'completed' },
      { id: 't4', content: 'Migrate existing API key sessions', status: 'in_progress' },
      { id: 't5', content: 'Remove legacy API key validation code', status: 'pending' },
    ],
  },
  {
    id: 'k-acme-done',
    title: 'Add rate limiting to /v1/search',
    cwd: '/Users/mock/projects/acme-api',
    messages: [
      userMsg('k10', 'Rate-limit the search endpoint.', KT - 3 * 60 * 60_000),
      asstMsg('k11', 'Added a token-bucket limiter at 20 req/s per key.', KT - 3 * 60 * 60_000 + 60_000,
        'Added a token-bucket rate limiter to /v1/search.'),
    ],
    createdAt: KT - 3 * 60 * 60_000,
    updatedAt: KT - 3 * 60 * 60_000 + 60_000,
    summary: 'Added a token-bucket rate limiter to /v1/search.',
    reviewed: true,
  },

  // ── Unassigned lane (no cwd → catch-all, always sorts last) ─────────────────
  {
    id: 'k-unassigned-new',
    title: 'Draft Q3 planning notes',
    cwd: '',
    messages: [
      userMsg('k12', 'Help me outline the Q3 planning doc.', KT - 10 * 60_000),
      asstMsg('k13', 'Outlined goals, bets, and risks across three sections.', KT - 9 * 60_000,
        'Outlined the Q3 planning doc — goals, bets, risks.'),
    ],
    createdAt: KT - 10 * 60_000,
    updatedAt: KT - 9 * 60_000,
    summary: 'Outlined the Q3 planning doc — goals, bets, risks.',
    reviewed: false,
  },
];
