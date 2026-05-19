/**
 * Pure utility functions for vault search.
 * Kept separate from ObsidianTools.ts so they can be unit-tested without
 * requiring the Obsidian API mock.
 */

const SEARCH_STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'to','of','in','and','or','it','its','that','this','with',
  'for','on','at','by','from','as','have','has','had',
  'do','does','did','will','would','could','should','may','might',
  'not','but','if','then','than','when','where','who','what','which','how',
  'i','you','he','she','we','they','me','him','her','us','them',
]);

/**
 * Splits a query string into lowercase search terms, stripping stopwords and
 * single-character tokens. Multi-word queries are matched term-by-term so
 * scattered occurrences are found even if the full phrase is absent.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length > 1 && !SEARCH_STOPWORDS.has(t));
}

/**
 * Returns a ~300-char excerpt from the region of `content` with the highest
 * density of term matches, rather than the position of the first exact-phrase
 * hit. Falls back to an empty string if no terms appear.
 *
 * @param content      The raw file content.
 * @param contentLower Pre-lowercased version of content (avoids repeated lowercasing).
 * @param terms        Tokenized query terms from {@link tokenizeQuery}.
 * @param windowSize   Width of the scoring window in characters (default 300).
 */
export function findBestExcerpt(
  content: string,
  contentLower: string,
  terms: string[],
  windowSize = 300,
): string {
  const positions: number[] = [];
  for (const term of terms) {
    let idx = contentLower.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = contentLower.indexOf(term, idx + 1);
    }
  }
  if (positions.length === 0) return '';
  positions.sort((a, b) => a - b);

  // Find the anchor whose forward window contains the most term hits
  let bestStart = positions[0];
  let bestCount = 0;
  for (let i = 0; i < positions.length; i++) {
    const windowEnd = positions[i] + windowSize;
    let count = 0;
    for (let j = i; j < positions.length && positions[j] < windowEnd; j++) count++;
    if (count > bestCount) {
      bestCount = count;
      bestStart = positions[i];
    }
  }

  const start = Math.max(0, bestStart - 60);
  const end = Math.min(content.length, start + windowSize + 60);
  return content.slice(start, end).replace(/\n/g, ' ').trim();
}
