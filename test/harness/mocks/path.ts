export default {
  join: (...args: string[]) => args.filter(Boolean).join('/').replace(/\/+/g, '/'),
  dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
  basename: (p: string, ext?: string) => {
    const b = p.split('/').pop() || '';
    return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
  },
  resolve: (...args: string[]) => args.join('/'),
};
