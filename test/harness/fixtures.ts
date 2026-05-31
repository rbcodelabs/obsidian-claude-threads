import type { Thread, ChatMessage } from '../../src/types';

// Timestamps: Thread 1 most recent (active by default), Thread 3 oldest
const now = Date.now();
const T1 = now - 5 * 60 * 1000;      // 5 minutes ago (most recent → active tab)
const T2 = now - 45 * 60 * 1000;     // 45 minutes ago
const T3 = now - 2 * 60 * 60 * 1000; // 2 hours ago

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
];
