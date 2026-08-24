// Named exports so dynamic require('path') at runtime gets the right shape.
export const join = (...args: string[]) => args.filter(Boolean).join('/').replace(/\/+/g, '/');
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/';
export const basename = (p: string, ext?: string) => {
  const b = p.split('/').pop() || '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const resolve = (...args: string[]) => args.join('/');
export const isAbsolute = (p: string) => p.startsWith('/');
export const relative = (from: string, to: string) => {
  const fromParts = from.split('/').filter(Boolean);
  const toParts = to.split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && fromParts[common] === toParts[common]) common++;
  return [...fromParts.slice(common).map(() => '..'), ...toParts.slice(common)].join('/');
};
export const sep = '/';
export default { join, dirname, basename, resolve, isAbsolute, relative, sep };
