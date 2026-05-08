export function query(_opts: unknown) {
  return (async function* () {})();
}

export type Options = Record<string, unknown>;
export type Query = AsyncIterable<unknown>;
export type CanUseTool = unknown;
