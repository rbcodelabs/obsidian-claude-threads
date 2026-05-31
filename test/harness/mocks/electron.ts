/** Mock for the 'electron' module — no-ops for the test harness */
export const shell = {
  openExternal: (_url: string): void => { /* no-op in harness */ },
  openPath: (_path: string): Promise<string> => Promise.resolve(''),
};
