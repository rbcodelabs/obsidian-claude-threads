/** Stub for the Electron module in the Playwright browser harness. */
export const shell = {
  openExternal: (_url: string): void => {},
  openPath: (_path: string): Promise<string> => Promise.resolve(''),
};
