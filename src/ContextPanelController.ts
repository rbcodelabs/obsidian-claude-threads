import type { App, TFile, ViewState, WorkspaceLeaf } from 'obsidian';

interface OwnedCompanion { workspace: object; chatLeaf: WorkspaceLeaf; companionLeaf: WorkspaceLeaf }
export type CompanionOwnershipStore = Map<string, OwnedCompanion>;
export function createCompanionOwnershipStore(): CompanionOwnershipStore { return new Map(); }
const defaultOwnershipStore = createCompanionOwnershipStore();
function createMarker(): string { return `ct-companion-${crypto.randomUUID()}`; }

export class ContextPanelController {
  private companionLeaf: WorkspaceLeaf | null = null;
  private activeMarker: string | undefined;
  private markerPersisted = false;
  private markerSave: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly getChatLeaf: () => WorkspaceLeaf | null,
    private readonly getPersistedMarker: () => string | undefined = () => undefined,
    private readonly persistMarker: (marker: string | undefined) => Promise<void> = async () => {},
    private readonly ownershipStore: CompanionOwnershipStore = defaultOwnershipStore,
  ) {}

  getLeaf(): WorkspaceLeaf {
    const chatLeaf = this.getChatLeaf();
    if (!chatLeaf) throw new Error('Claude Threads chat must be open before contextual content can be shown.');
    const restored = this.findOwnedCompanion(chatLeaf);
    if (restored) { this.companionLeaf = restored; return restored; }

    const workspace = this.app.workspace;
    workspace.revealLeaf(chatLeaf);
    const companionLeaf = workspace.splitActiveLeaf('vertical');
    const marker = createMarker();
    this.ownershipStore.set(marker, { workspace, chatLeaf, companionLeaf });
    this.activeMarker = marker;
    this.markerPersisted = false;
    this.companionLeaf = companionLeaf;
    void this.ensureMarkerPersisted();
    return companionLeaf;
  }

  async openFile(file: TFile): Promise<void> {
    const leaf = this.getLeaf();
    await this.ensureMarkerPersisted();
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  async openLinkText(linktext: string, sourcePath = ''): Promise<void> {
    const leaf = this.getLeaf();
    await this.ensureMarkerPersisted();
    this.app.workspace.revealLeaf(leaf);
    await this.app.workspace.openLinkText(linktext, sourcePath, false);
  }

  async setViewState(viewState: ViewState): Promise<boolean> {
    const reused = this.hasReusableLeaf();
    const leaf = this.getLeaf();
    await this.ensureMarkerPersisted();
    await leaf.setViewState(viewState);
    this.app.workspace.revealLeaf(leaf);
    return reused;
  }

  async dispose(): Promise<void> {
    const marker = this.activeMarker ?? this.getPersistedMarker();
    const owned = typeof marker === 'string' ? this.ownershipStore.get(marker) : undefined;
    if (owned?.workspace === this.app.workspace && this.isAttached(owned.companionLeaf)) owned.companionLeaf.detach();
    if (marker) this.ownershipStore.delete(marker);
    this.companionLeaf = null;
    this.activeMarker = undefined;
    this.markerPersisted = false;
    await this.persistMarker(undefined).catch((error) => {
      console.warn('[ClaudeThreads] Failed to clear companion marker during unload:', error);
    });
  }

  private hasReusableLeaf(): boolean {
    const chatLeaf = this.getChatLeaf();
    return Boolean(chatLeaf && this.findOwnedCompanion(chatLeaf));
  }

  private findOwnedCompanion(chatLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const persistedMarker = this.getPersistedMarker();
    const marker = this.activeMarker ?? persistedMarker;
    if (typeof marker !== 'string') return null;
    const owned = this.ownershipStore.get(marker);
    if (!owned) return null;
    const valid = owned.workspace === this.app.workspace && owned.chatLeaf === chatLeaf
      && this.isAttached(chatLeaf) && this.isAttached(owned.companionLeaf);
    if (!valid) {
      if (owned.workspace === this.app.workspace && this.isAttached(owned.companionLeaf)) owned.companionLeaf.detach();
      this.ownershipStore.delete(marker);
      this.companionLeaf = null;
      this.activeMarker = undefined;
      this.markerPersisted = false;
      void this.persistMarker(undefined).catch((error) => {
        console.warn('[ClaudeThreads] Failed to clear stale companion marker:', error);
      });
      return null;
    }
    this.activeMarker = marker;
    this.markerPersisted = this.markerPersisted || marker === persistedMarker;
    return owned.companionLeaf;
  }

  private async ensureMarkerPersisted(): Promise<void> {
    if (!this.activeMarker || this.markerPersisted) return;
    if (!this.markerSave) {
      const marker = this.activeMarker;
      this.markerSave = this.persistMarker(marker)
        .then(() => { if (this.activeMarker === marker) this.markerPersisted = true; })
        .catch((error) => console.warn('[ClaudeThreads] Failed to persist companion marker; will retry:', error))
        .finally(() => { this.markerSave = null; });
    }
    await this.markerSave;
  }

  private isAttached(target: WorkspaceLeaf): boolean {
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => { if (leaf === target) attached = true; });
    return attached;
  }
}
