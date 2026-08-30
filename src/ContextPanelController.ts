import type { App, TFile, ViewState, WorkspaceLeaf } from 'obsidian';

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
  ) {}

  /** Return the existing attached companion, or create one beside chat. */
  getLeaf(): WorkspaceLeaf {
    if (this.companionLeaf && this.isAttached(this.companionLeaf)) {
      return this.companionLeaf;
    }

    const chatLeaf = this.getChatLeaf();
    if (!chatLeaf) {
      throw new Error('Claude Threads chat must be open before contextual content can be shown.');
    }

    const workspace = this.app.workspace;
    workspace.setActiveLeaf(chatLeaf, { focus: false });
    this.companionLeaf = workspace.splitActiveLeaf('vertical');
    return this.companionLeaf;
  }

  async openFile(file: TFile): Promise<void> {
    const leaf = this.getLeaf();
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  async openLinkText(linktext: string, sourcePath = ''): Promise<void> {
    const leaf = this.getLeaf();
    // openLinkText(false) targets the active navigable leaf. Make the explicit
    // companion active first so the centered chat can never be selected.
    this.app.workspace.setActiveLeaf(leaf, { focus: false });
    await this.app.workspace.openLinkText(linktext, sourcePath, false);
  }

  async setViewState(viewState: ViewState): Promise<void> {
    const leaf = this.getLeaf();
    await leaf.setViewState(viewState);
    this.app.workspace.revealLeaf(leaf);
  }

  private isAttached(target: WorkspaceLeaf): boolean {
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === target) attached = true;
    });
    return attached;
  }
}
