/**
 * Stub for Node's `crypto` module in the Playwright browser harness.
 *
 * `skillManager.ts` statically imports `createHash` to derive the deterministic
 * skill-source id from a repo URL. esbuild's `platform: 'browser'` target can't
 * resolve Node built-ins, so — like `fs`, `path` and `child_process` — it gets
 * aliased to a stub here.
 *
 * The digest below is FNV-1a, NOT a cryptographic hash. It exists purely so the
 * bundle links and so anything that did reach it would get a stable hex string
 * rather than a crash. No screenshot test derives a source id, and nothing in
 * `src/` uses this module for anything security-sensitive (the derived id is a
 * directory name). If that ever changes, this stub must not be trusted.
 */

interface StubHash {
  update: (data: string) => StubHash;
  digest: (encoding?: string) => string;
}

export const createHash = (_algorithm: string): StubHash => {
  let input = '';
  const hash: StubHash = {
    update: (data: string) => {
      input += data;
      return hash;
    },
    // Repeat a 32-bit FNV-1a digest so the returned string is long enough for
    // callers that slice a prefix out of it (skillManager takes 16 chars).
    digest: () => {
      let h = 0x811c9dc5;
      for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      const word = h.toString(16).padStart(8, '0');
      return word.repeat(8);
    },
  };
  return hash;
};
