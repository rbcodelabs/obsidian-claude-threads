import type { App, TFile, ViewState, WorkspaceLeaf } from 'obsidian';

interface OwnedCompanion {
  workspace: object;
  chatLeaf: WorkspaceLeaf;
  companionLeaf: WorkspaceLeaf;
}

// Survives controller recreation within the live plugin module, while never
// guessing from native file paths or view state after a renderer restart.
const ownedCompanions = new Map<string, OwnedCompanion>();

function createMarker(): string {
  return `ct-companion-${crypto.randomUUID()}`;
}

/** Owns the single native companion used by conversation-first mode. */
export class ContextPanelController {
  private companionLeaf: WorkspaceLeaf | null = null;
  private markerSave: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly getChatLeaf: () => WorkspaceLeaf | null,
    private readonly getPersistedMarker: () => string | undefined = () => undefined,
    private readonly persistMarker: (marker: string) => Promise<void> = async () => {},
  ) {}

  /** Return the exact live companion this controller created, or create one beside chat. */
  getLeaf(): WorkspaceLeaf {
    if (this.companionLeaf && this.isAttached(this.companionLeaf)) return this.companionLeaf;

    const chatLeaf = this.getChatLeaf();
    if (!chatLeaf) throw new Error('Claude Threads chat must be open before contextual content can be shown.');

    const restored = this.findOwnedCompanion(chatLeaf);
    if (restored) {
      this.companionLeaf = restored;
      return restored;
    }

    const workspace = this.app.workspace;
    workspace.revealLeaf(chatLeaf);
    const companionLeaf = workspace.splitActiveLeaf('vertical');
    const marker = createMarker();
    ownedCompanions.set(marker, { workspace, chatLeaf, companionLeaf });
    this.companionLeaf = companionLeaf;
    this.markerSave = this.persistMarker(marker);
    return companionLeaf;
  }

  async openFile(file: TFile): Promise<void> {
    const leaf = this.getLeaf();
    await this.markerSave;
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  async openLinkText(linktext: string, sourcePath = ''): Promise<void> {
    const leaf = this.getLeaf();
    await this.markerSave;
    this.app.workspace.revealLeaf(leaf);
    await this.app.workspace.openLinkText(linktext, sourcePath, false);
  }

  async setViewState(viewState: ViewState): Promise<boolean> {
    const reused = this.hasReusableLeaf();
    const leaf = this.getLeaf();
    await this.markerSave;
    await leaf.setViewState(viewState);
    this.app.workspace.revealLeaf(leaf);
    return reused;
  }

  private hasReusableLeaf(): boolean {
    const chatLeaf = this.getChatLeaf();
    return Boolean(
      (this.companionLeaf && this.isAttached(this.companionLeaf))
      || (chatLeaf && this.findOwnedCompanion(chatLeaf)),
    );
  }

  private findOwnedCompanion(chatLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const marker = this.getPersistedMarker();
    if (typeof marker !== 'string') return null;
    const owned = ownedCompanions.get(marker);
    if (!owned) return null;
    const valid = owned.workspace === this.app.workspace
      && owned.chatLeaf === chatLeaf
      && this.isAttached(chatLeaf)
      && this.isAttached(owned.companionLeaf);
    if (!valid) {
      ownedCompanions.delete(marker);
      return null;
    }
    return owned.companionLeaf;
  }

  private isAttached(target: WorkspaceLeaf): boolean {
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === target) attached = true;
    });
    return attached;
  }
}
