import { describe, it, expect } from 'vitest';
import { tokenizeQuery, findBestExcerpt } from '../../src/searchUtils';

// ── tokenizeQuery ─────────────────────────────────────────────────────────────

describe('tokenizeQuery', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenizeQuery('Project Planning')).toEqual(['project', 'planning']);
  });

  it('removes stopwords', () => {
    expect(tokenizeQuery('what is the plan')).toEqual(['plan']);
  });

  it('removes single-character tokens', () => {
    expect(tokenizeQuery('a b project')).toEqual(['project']);
  });

  it('splits on punctuation and non-word chars', () => {
    expect(tokenizeQuery('project/planning, notes')).toEqual(['project', 'planning', 'notes']);
  });

  it('returns empty array for all-stopword queries', () => {
    expect(tokenizeQuery('what is that')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(tokenizeQuery('')).toEqual([]);
  });

  it('handles multi-word phrase Claude might generate', () => {
    // Typical failure case from the old indexOf approach: these words appear
    // scattered in notes but not as a contiguous phrase
    const terms = tokenizeQuery('project planning meeting notes');
    expect(terms).toContain('project');
    expect(terms).toContain('planning');
    expect(terms).toContain('meeting');
    expect(terms).toContain('notes');
    expect(terms).not.toContain('the');
  });

  it('deduplication is not required — duplicates survive (scoring handles weighting)', () => {
    // tokenizeQuery is a simple split; frequency is counted at scoring time
    const terms = tokenizeQuery('project project');
    expect(terms).toEqual(['project', 'project']);
  });
});

// ── findBestExcerpt ───────────────────────────────────────────────────────────

describe('findBestExcerpt', () => {
  const lower = (s: string) => s.toLowerCase();

  it('returns empty string when no terms appear in content', () => {
    const content = 'Nothing relevant here.';
    expect(findBestExcerpt(content, lower(content), ['zebra'])).toBe('');
  });

  it('returns an excerpt containing a single matched term', () => {
    const content = 'Some text about project management.';
    const excerpt = findBestExcerpt(content, lower(content), ['project']);
    expect(excerpt).toContain('project');
  });

  it('prefers the region with the most term hits when matches are scattered', () => {
    // Three hits clustered at the end, one lone hit at the start
    const sparse = 'planning is mentioned here. ' + 'x '.repeat(200);
    const dense  = 'planning project meeting notes for the planning session';
    const content = sparse + dense;
    const terms = ['planning', 'project', 'meeting', 'notes'];
    const excerpt = findBestExcerpt(content, lower(content), terms);
    // The excerpt should be drawn from the dense region, not the sparse one
    expect(excerpt).toContain('project');
    expect(excerpt).toContain('meeting');
  });

  it('excerpt length is bounded to roughly windowSize + context padding', () => {
    const content = 'start ' + 'word '.repeat(500) + 'target ' + 'word '.repeat(500) + 'end';
    const excerpt = findBestExcerpt(content, lower(content), ['target'], 300);
    // 300 window + 60 pre-context + 60 post = 420 chars max; allow some slack
    expect(excerpt.length).toBeLessThanOrEqual(450);
  });

  it('clamps start to 0 when match is near the beginning of content', () => {
    const content = 'project notes start here and continue on.';
    const excerpt = findBestExcerpt(content, lower(content), ['project']);
    expect(excerpt.startsWith('project')).toBe(true);
  });

  it('collapses newlines to spaces in the returned excerpt', () => {
    const content = 'line one\nproject notes\nline three';
    const excerpt = findBestExcerpt(content, lower(content), ['project']);
    expect(excerpt).not.toContain('\n');
  });

  it('handles multiple occurrences of the same term', () => {
    const content = 'project intro. ' + 'filler '.repeat(100) + 'project project project end';
    const excerpt = findBestExcerpt(content, lower(content), ['project']);
    // Should gravitate to the cluster of three, not the lone intro hit
    expect(excerpt).toContain('project project');
  });
});
