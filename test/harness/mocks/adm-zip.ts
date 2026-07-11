/**
 * Stub for the `adm-zip` module in the Playwright browser harness.
 *
 * `adm-zip` is a Node-only CommonJS package (it pulls in `zlib`/`crypto`
 * internally), so esbuild's `platform: 'browser'` bundle can't resolve it.
 * The harness never actually extracts a zip archive through the UI in tests
 * (screenshot tests only exercise rendering, not the import-file flow's
 * filesystem side effects), so a minimal no-op stand-in matching the shape
 * `extractZipToDir` uses (`new AdmZip(path)`, `.getEntries()`,
 * `.extractAllToAsync()`) is enough to keep the bundle from crashing at load.
 */
export default class AdmZip {
  constructor(_zipPath?: string) {}

  getEntries(): Array<{ entryName: string }> {
    return [];
  }

  extractAllToAsync(
    _targetPath: string,
    _overwrite?: boolean,
    _keepOriginalPermission?: boolean,
    callback?: (err?: Error) => void,
  ): Promise<void> {
    if (typeof callback === 'function') {
      callback();
      return Promise.resolve();
    }
    return Promise.resolve();
  }
}
