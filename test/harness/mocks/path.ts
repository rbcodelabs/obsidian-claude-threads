// Named exports so dynamic require('path') at runtime gets the right shape.
export const join = (...args: string[]) => args.filter(Boolean).join('/').replace(/\/+/g, '/');
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/';
export const basename = (p: string, ext?: string) => {
  const b = p.split('/').pop() || '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const resolve = (...args: string[]) => args.join('/');
export default { join, dirname, basename, resolve };
