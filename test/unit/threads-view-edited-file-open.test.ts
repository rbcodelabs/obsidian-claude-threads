import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

type TestView = ThreadsView & {
  openEditedFile(filePath: string): Promise<void>;
};

function makeView(options: {
  webViewerEnabled?: boolean;
  vaultBase?: string;
  vaultFiles?: Record<string, object>;
} = {}) {
  const vaultFiles = options.vaultFiles ?? {};
  const openLink = vi.fn();
  const openFile = vi.fn().mockResolvedValue(undefined);
  const getAbstractFileByPath = vi.fn((filePath: string) => vaultFiles[filePath] ?? null);
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    app: {
      internalPlugins: {
        plugins: { webviewer: { enabled: options.webViewerEnabled ?? true } },
      },
      vault: {
        adapter: { basePath: options.vaultBase ?? '/vault' },
        getAbstractFileByPath,
      },
      workspace: { getLeaf: vi.fn(() => ({ openFile })) },
    },
    plugin: {
      isConversationFirst: () => false,
      contextPanel: { openFile: vi.fn() },
    },
    openLink,
    getBridges: () => [],
  }) as TestView;

  return { view, openLink, openFile, getAbstractFileByPath };
}

describe('ThreadsView.openEditedFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['/tmp/report.html', 'file:///tmp/report.html'],
    ['/tmp/report.HTM', 'file:///tmp/report.HTM'],
  ])('opens external HTML path %s in the Web Viewer', async (filePath, expectedUrl) => {
    const { view, openLink, openFile } = makeView();

    await view.openEditedFile(filePath);

    expect(openLink).toHaveBeenCalledWith(expectedUrl);
    expect(openFile).not.toHaveBeenCalled();
  });

  it('continues to open vault HTML in the Web Viewer', async () => {
    const file = {};
    const { view, openLink, openFile } = makeView({
      vaultFiles: { 'docs/report.html': file },
    });

    await view.openEditedFile('/vault/docs/report.html');

    expect(openLink).toHaveBeenCalledWith('file:///vault/docs/report.html');
    expect(openFile).not.toHaveBeenCalled();
  });
});
