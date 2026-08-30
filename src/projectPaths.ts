/** Return the desktop vault's actual filesystem root for Project folder resolution. */
export function resolveProjectVaultRoot(adapter: unknown): string {
  if (
    typeof adapter === 'object' &&
    adapter !== null &&
    'getBasePath' in adapter &&
    typeof (adapter as { getBasePath?: unknown }).getBasePath === 'function'
  ) {
    return (adapter as { getBasePath: () => string }).getBasePath();
  }
  return '';
}
