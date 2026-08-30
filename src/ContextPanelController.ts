import type { App, TFile, ViewState, WorkspaceLeaf } from 'obsidian';

export interface CompanionIdentity {
  type: string;
  state?: unknown;
  filePath?: string;
}

/**
 * Owns the single native companion used by conversation-first mode.
 *
 * The controller deliberately tracks a leaf rather than a view type: the same
 * adjacent workspace position can host Markdown, Web Viewer, and registered
 * artifact views without creating competing context panes.
 */
export class ContextPanelController {
  private companionLeaf: WorkspaceLeaf | null = null;

  constructor(
    private readonly app: App,
    private readonly getChatLeaf: () => WorkspaceLeaf | null,
    private readonly getPersistedIdentity: () => CompanionIdentity | undefined = () => undefined,
    private readonly persistIdentity: (identity: CompanionIdentity) => Promise<void> = async () => {},
  ) {}

  /** Return the existing attached companion, or create one beside chat. */
  getLeaf(): WorkspaceLeaf {
    if (this.companionLeaf && this.isAttached(this.companionLeaf)) {
      return this.companionLeaf;
    }

    const restored = this.findRestoredCompanion();
    if (restored) {
      this.companionLeaf = restored;
      return restored;
    }

    const chatLeaf = this.getChatLeaf();
    if (!chatLeaf) {
      throw new Error('Claude Threads chat must be open before contextual content can be shown.');
    }

    const workspace = this.app.workspace;
    workspace.revealLeaf(chatLeaf);
    this.companionLeaf = workspace.splitActiveLeaf('vertical');
    return this.companionLeaf;
  }

  async openFile(file: TFile): Promise<void> {
    const leaf = this.getLeaf();
    await leaf.openFile(file);
    await this.persistCurrentIdentity(leaf);
    this.app.workspace.revealLeaf(leaf);
  }

  async openLinkText(linktext: string, sourcePath = ''): Promise<void> {
    const leaf = this.getLeaf();
    // openLinkText(false) targets the active navigable leaf.
    this.app.workspace.revealLeaf(leaf);
    await this.app.workspace.openLinkText(linktext, sourcePath, false);
    await this.persistCurrentIdentity(leaf);
  }

  async setViewState(viewState: ViewState): Promise<void> {
    const leaf = this.getLeaf();
    await leaf.setViewState(viewState);
    await this.persistCurrentIdentity(leaf);
    this.app.workspace.revealLeaf(leaf);
  }

  private isAttached(target: WorkspaceLeaf): boolean {
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === target) attached = true;
    });
    return attached;
  }

  private findRestoredCompanion(): WorkspaceLeaf | null {
    const expected = this.getPersistedIdentity();
    if (!expected) return null;
    let match: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!match && leaf !== this.getChatLeaf() && this.identitiesMatch(this.identityOf(leaf), expected)) match = leaf;
    });
    return match;
  }

  private async persistCurrentIdentity(leaf: WorkspaceLeaf): Promise<void> {
    await this.persistIdentity(this.identityOf(leaf));
  }

  private identityOf(leaf: WorkspaceLeaf): CompanionIdentity {
    const viewState = leaf.getViewState();
    const filePath = (leaf.view as unknown as { file?: { path?: unknown } } | undefined)?.file?.path;
    return {
      type: viewState.type,
      ...(viewState.state !== undefined ? { state: viewState.state } : {}),
      ...(typeof filePath === 'string' ? { filePath } : {}),
    };
  }

  private identitiesMatch(actual: CompanionIdentity, expected: CompanionIdentity): boolean {
    if (actual.type !== expected.type) return false;
    if (expected.filePath !== undefined) return actual.filePath === expected.filePath;
    return JSON.stringify(actual.state) === JSON.stringify(expected.state);
  }
}
