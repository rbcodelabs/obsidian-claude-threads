import { ItemView, WorkspaceLeaf, setIcon, Notice, Modal, App, requestUrl } from 'obsidian';
import type ClaudeThreadsPlugin from './main';

export const SKILLS_VIEW_TYPE = 'claude-threads:skills';

// ── Types ────────────────────────────────────────────────────────────────────

interface InstalledSkill {
  name: string;
  description: string;
  /** Path inside ~/.claude/skills/ (may be a symlink) */
  skillPath: string;
  /** Resolved real path after following symlinks */
  realPath: string;
  isSymlink: boolean;
  isDirectory: boolean;
  /** Absolute path to the SKILL.md (or .md file) to read/write */
  skillMdPath: string;
  content: string;
  /** Name of the configured SkillSource this skill's real path belongs to, if any */
  sourceName?: string;
}

interface BrowseSkill {
  name: string;
  /** Full skills.sh id, e.g. "owner/repo/skill-name". Used as the canonical key. */
  slug: string;
  /** Bare skill folder name (last path segment of slug). Used as the install dir basename. */
  skillId: string;
  source: string;
  installs: number;
  isInstalled: boolean;
}

interface LocalSkill {
  id: string;           // subdir name
  name: string;         // from SKILL.md frontmatter, or subdir name
  description: string;
  skillsPath: string;   // expanded skillsPath from source
  skillDir: string;     // full path to this skill's directory
  isLinked: boolean;
  /** True when this skill comes from a github-type source (registered via settings.json, no symlink needed) */
  isGithubSource?: boolean;
}

interface InstalledAgent {
  name: string;
  description: string;
  /** Absolute path to the .md file */
  agentPath: string;
  content: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: '', description: '' };
  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch?.[1]?.trim() ?? '',
    description: descMatch?.[1]?.trim() ?? '',
  };
}

function formatInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  return `${count} install${count === 1 ? '' : 's'}`;
}

// ── Confirmation Modal ────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
  private onResult: (confirmed: boolean) => void;
  private message: string;
  private confirmLabel: string;

  constructor(
    app: App,
    message: string,
    confirmLabel: string,
    onResult: (confirmed: boolean) => void,
  ) {
    super(app);
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.onResult = onResult;
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    const btns = this.contentEl.createEl('div', { cls: 'ct-skills-modal-btns' });
    btns.createEl('button', { cls: 'ct-skills-btn', text: 'Cancel' }).addEventListener('click', () => {
      this.close();
      this.onResult(false);
    });
    btns.createEl('button', { cls: 'ct-skills-btn ct-skills-btn--danger', text: this.confirmLabel }).addEventListener('click', () => {
      this.close();
      this.onResult(true);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Main View ─────────────────────────────────────────────────────────────────

export class SkillsManagerView extends ItemView {
  private plugin: ClaudeThreadsPlugin;

  // Tab state
  private activeTab: 'installed' | 'browse' = 'installed';

  // Installed tab
  private installedSkills: InstalledSkill[] = [];
  private selectedInstalled: InstalledSkill | null = null;
  private editContent = '';
  private isDirty = false;
  private installedFilter = '';

  // Agents (Installed tab)
  private installedAgents: InstalledAgent[] = [];
  private selectedAgent: InstalledAgent | null = null;
  private agentEditContent = '';
  private isAgentDirty = false;

  // Browse tab
  private browseResults: BrowseSkill[] = [];
  private browsePopularResults: BrowseSkill[] = [];
  private selectedBrowse: BrowseSkill | null = null;
  private browseQuery = '';
  private isBrowseLoading = false;
  private isPopularLoading = false;
  private browseSearchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cache of fetched SKILL.md descriptions keyed by slug */
  private browseDescriptions: Map<string, string | null> = new Map();
  /** Slugs currently being fetched */
  private browseDescLoading: Set<string> = new Set();
  /** Active browse source: 'registry' for skills.sh, or a SkillSource ID for a local source */
  private browseSource: 'registry' | string = 'registry';
  /** Skills loaded from the active local source */
  private localSkills: LocalSkill[] = [];
  /** Selected skill from a local source */
  private selectedLocalSkill: LocalSkill | null = null;
  /** Whether local skills are loading */
  private isLocalSkillsLoading = false;

  /** Selected GitHub source plugin in the Installed tab */
  private selectedGithubSource: import('./types').SkillSource | null = null;
  /** Skills loaded for the selected GitHub source (installed tab detail) */
  private githubSourceSkills: LocalSkill[] = [];
  /** Whether github source skills are loading */
  private isGithubSourceSkillsLoading = false;

  // Install progress
  private installingSlug: string | null = null;
  private installOutput = '';

  // DOM refs (stable across re-renders)
  private tabsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return SKILLS_VIEW_TYPE; }
  getDisplayText(): string { return 'Skills Manager'; }
  getIcon(): string { return 'puzzle'; }

  async onOpen(): Promise<void> {
    this.buildShell();
    await Promise.all([this.loadInstalledSkills(), this.loadInstalledAgents()]);
    // Background staleness check for github sources
    void this.checkAllSourceStaleness();
  }

  /** Re-load installed skills and agents, then re-render the list/detail panes. Called by
   *  SettingsTab when a new GitHub source is added so the view stays in sync. */
  async refresh(): Promise<void> {
    await Promise.all([this.loadInstalledSkills(), this.loadInstalledAgents()]);
    this.renderList();
    this.renderDetail();
    void this.checkAllSourceStaleness();
  }

  private async checkAllSourceStaleness(): Promise<void> {
    const sources = (this.plugin.settings.skillSources ?? []).filter(
      (s) => s.type === 'github' && s.clonePath,
    );
    for (const source of sources) {
      void this.fetchSourceStaleness(source);
    }
  }

  private async fetchSourceStaleness(source: import('./types').SkillSource): Promise<void> {
    if (!source.clonePath) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    try {
      execSync(`git -C "${source.clonePath}" fetch --quiet --timeout=15`, {
        stdio: 'pipe',
        timeout: 20_000,
      });
      const countOutput = execSync(
        `git -C "${source.clonePath}" rev-list HEAD..origin/HEAD --count`,
        { stdio: 'pipe', timeout: 5_000 },
      );
      const count = parseInt(countOutput.toString().trim(), 10);
      source.behindCount = isNaN(count) ? 0 : count;
      source.lastFetched = Date.now();
      await this.plugin.saveSettings();
      // Re-render to reflect updated staleness badges
      this.renderList();
      if (this.selectedGithubSource?.id === source.id) {
        this.renderDetail();
      }
    } catch {
      // Network unavailable or git error — ignore silently
    }
  }

  async onClose(): Promise<void> {
    if (this.browseSearchTimer) clearTimeout(this.browseSearchTimer);
  }

  // ── Shell (built once) ────────────────────────────────────────────────────

  private buildShell(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-skills-root');

    // Reset Obsidian's default button box-shadow in our root
    // (ct-skills-root button rule in styles.css handles this)

    // Tab bar
    this.tabsEl = root.createEl('div', { cls: 'ct-skills-tabs' });
    this.buildTabs();

    // Body: left list + right detail
    const body = root.createEl('div', { cls: 'ct-skills-body' });
    this.listEl = body.createEl('div', { cls: 'ct-skills-list' });
    this.detailEl = body.createEl('div', { cls: 'ct-skills-detail' });

    this.renderList();
    this.renderDetail();
  }

  private buildTabs(): void {
    this.tabsEl.empty();

    const tabs: Array<{ id: 'installed' | 'browse'; label: string }> = [
      { id: 'installed', label: 'Installed' },
      { id: 'browse', label: 'Browse' },
    ];

    for (const tab of tabs) {
      const btn = this.tabsEl.createEl('button', {
        cls: 'ct-skills-tab' + (this.activeTab === tab.id ? ' ct-skills-tab--active' : ''),
        text: tab.label,
      });
      btn.addEventListener('click', () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        if (tab.id !== 'installed') {
          this.selectedGithubSource = null;
          this.githubSourceSkills = [];
        }
        this.buildTabs();
        this.renderList();
        this.renderDetail();
        if (tab.id === 'browse' && this.browsePopularResults.length === 0 && !this.isPopularLoading) {
          void this.fetchPopularSkills();
        }
      });
    }
  }

  // ── List Panel ─────────────────────────────────────────────────────────────

  private renderList(): void {
    this.listEl.empty();
    if (this.activeTab === 'installed') {
      this.renderInstalledList();
    } else {
      this.renderBrowseList();
    }
  }

  private renderInstalledList(): void {
    const githubSources = (this.plugin.settings.skillSources ?? []).filter(s => s.type === 'github');

    // ── Agents section ───────────────────────────────────────────────────────
    const filteredAgents = this.installedAgents.filter(
      (a) =>
        !this.installedFilter ||
        a.name.toLowerCase().includes(this.installedFilter.toLowerCase()) ||
        a.description.toLowerCase().includes(this.installedFilter.toLowerCase()),
    );

    if (this.installedAgents.length > 0) {
      this.listEl.createEl('div', { cls: 'ct-skills-section-label', text: 'Agents' });

      for (const agent of filteredAgents) {
        const isActive = this.selectedAgent?.name === agent.name;
        const card = this.listEl.createEl('div', {
          cls: 'ct-skills-card' + (isActive ? ' ct-skills-card--active' : ''),
        });

        const main = card.createEl('div', { cls: 'ct-skills-card-main' });
        main.createEl('div', { cls: 'ct-skills-card-name', text: agent.name });
        if (agent.description) {
          main.createEl('div', { cls: 'ct-skills-card-desc', text: agent.description });
        }

        card.addEventListener('click', () => {
          this.selectedAgent = agent;
          this.selectedInstalled = null;
          this.selectedGithubSource = null;
          this.agentEditContent = agent.content;
          this.isAgentDirty = false;
          this.renderList();
          this.renderDetail();
        });
      }
    }

    // ── Active Plugins section ───────────────────────────────────────────────
    if (githubSources.length > 0) {
      this.listEl.createEl('div', { cls: 'ct-skills-section-label', text: 'Active Plugins' });

      for (const source of githubSources) {
        const isActive = this.selectedGithubSource?.id === source.id;
        const card = this.listEl.createEl('div', {
          cls: 'ct-skills-card ct-skills-plugin-card' + (isActive ? ' ct-skills-card--active' : ''),
        });

        const main = card.createEl('div', { cls: 'ct-skills-card-main' });
        main.createEl('div', { cls: 'ct-skills-card-name', text: source.name });
        if (source.repoUrl) {
          main.createEl('div', { cls: 'ct-skills-card-desc', text: source.repoUrl });
        }

        if (source.behindCount && source.behindCount > 0) {
          card.createEl('span', {
            cls: 'ct-skills-badge ct-skills-badge--warn',
            text: `• ${source.behindCount} update${source.behindCount > 1 ? 's' : ''}`,
          });
        } else {
          card.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--global', text: 'active' });
        }

        card.addEventListener('click', () => {
          this.selectedGithubSource = source;
          this.selectedInstalled = null;
          this.githubSourceSkills = [];
          this.renderList();
          this.renderDetail();
          void this.loadGithubSourceSkillsForInstalled(source);
        });
      }

      // Separator / section label for individual skills
      if (this.installedSkills.length > 0) {
        this.listEl.createEl('div', { cls: 'ct-skills-section-label', text: 'Individual Skills' });
      }
    }

    // ── Search / filter bar ──────────────────────────────────────────────────
    const searchRow = this.listEl.createEl('div', { cls: 'ct-skills-search-row' });
    const searchIcon = searchRow.createEl('span', { cls: 'ct-skills-search-icon' });
    setIcon(searchIcon, 'search');
    const searchInput = searchRow.createEl('input', {
      cls: 'ct-skills-search',
      attr: { type: 'text', placeholder: 'Filter skills and agents…', value: this.installedFilter },
    });
    searchInput.addEventListener('input', () => {
      this.installedFilter = searchInput.value;
      this.renderList();
      // Restore focus after re-render
      const next = this.listEl.querySelector<HTMLInputElement>('.ct-skills-search');
      if (next) {
        next.focus();
        const len = next.value.length;
        next.setSelectionRange(len, len);
      }
    });

    const filtered = this.installedSkills.filter(
      (s) =>
        !this.installedFilter ||
        s.name.toLowerCase().includes(this.installedFilter.toLowerCase()) ||
        s.description.toLowerCase().includes(this.installedFilter.toLowerCase()),
    );

    const skillCount = this.installedSkills.length;
    const filteredSkillCount = filtered.length;
    const agentCount = this.installedAgents.length;
    const filteredAgentCount = filteredAgents.length;

    let countText = `${filteredSkillCount} of ${skillCount} skill${skillCount !== 1 ? 's' : ''}`;
    if (agentCount > 0) {
      countText += ` · ${filteredAgentCount} of ${agentCount} agent${agentCount !== 1 ? 's' : ''}`;
    }
    this.listEl.createEl('div', { cls: 'ct-skills-count', text: countText });

    const inner = this.listEl.createEl('div', { cls: 'ct-skills-list-inner' });

    if (this.installedSkills.length === 0) {
      inner.createEl('div', { cls: 'ct-skills-empty', text: 'No skills found in ~/.claude/skills/' });
      return;
    }
    if (filtered.length === 0) {
      inner.createEl('div', { cls: 'ct-skills-empty', text: 'No skills match your filter' });
      return;
    }

    for (const skill of filtered) {
      const isActive = this.selectedInstalled?.name === skill.name;
      const card = inner.createEl('div', {
        cls: 'ct-skills-card' + (isActive ? ' ct-skills-card--active' : ''),
      });

      const main = card.createEl('div', { cls: 'ct-skills-card-main' });
      main.createEl('div', { cls: 'ct-skills-card-name', text: skill.name });
      if (skill.description) {
        main.createEl('div', { cls: 'ct-skills-card-desc', text: skill.description });
      }

      if (skill.sourceName) {
        card.createEl('span', { cls: 'ct-skills-badge', text: skill.sourceName });
      } else if (skill.isSymlink) {
        card.createEl('span', { cls: 'ct-skills-badge', text: 'symlink' });
      }

      card.addEventListener('click', () => {
        this.selectedInstalled = skill;
        this.selectedGithubSource = null;
        this.selectedAgent = null;
        this.editContent = skill.content;
        this.isDirty = false;
        this.renderList();
        this.renderDetail();
      });
    }
  }

  private renderBrowseList(): void {
    const sources = (this.plugin.settings.skillSources ?? []).filter(s => s.type === 'local');

    // Source switcher (only shown when at least one local source is configured)
    if (sources.length > 0) {
      const switcher = this.listEl.createEl('div', { cls: 'ct-skills-source-switcher' });

      const registryPill = switcher.createEl('button', {
        cls: 'ct-skills-tab' + (this.browseSource === 'registry' ? ' ct-skills-tab--active' : ''),
        text: 'skills.sh',
      });
      registryPill.addEventListener('click', () => {
        if (this.browseSource === 'registry') return;
        this.browseSource = 'registry';
        this.selectedLocalSkill = null;
        this.renderList();
        this.renderDetail();
      });

      for (const source of sources) {
        const pill = switcher.createEl('button', {
          cls: 'ct-skills-tab' + (this.browseSource === source.id ? ' ct-skills-tab--active' : ''),
          text: source.name,
        });
        pill.addEventListener('click', () => {
          if (this.browseSource === source.id) return;
          this.browseSource = source.id;
          this.selectedLocalSkill = null;
          this.localSkills = [];
          this.renderList();
          this.renderDetail();
          void this.loadLocalSkills(source.id);
        });
      }
    }

    // ── Local source browsing ────────────────────────────────────────────────
    if (this.browseSource !== 'registry') {
      this.renderLocalBrowseList();
      return;
    }

    // ── Registry browsing (existing skills.sh behavior) ──────────────────────
    const searchRow = this.listEl.createEl('div', { cls: 'ct-skills-search-row' });
    const searchIcon = searchRow.createEl('span', { cls: 'ct-skills-search-icon' });
    setIcon(searchIcon, 'search');
    const searchInput = searchRow.createEl('input', {
      cls: 'ct-skills-search',
      attr: { type: 'text', placeholder: 'Search skills.sh…', value: this.browseQuery },
    });
    searchInput.addEventListener('input', () => {
      this.browseQuery = searchInput.value;
      if (this.browseSearchTimer) clearTimeout(this.browseSearchTimer);
      if (this.browseQuery.length < 2) {
        this.browseResults = [];
        this.isBrowseLoading = false;
        this.renderList();
        return;
      }
      this.isBrowseLoading = true;
      this.renderList();
      this.browseSearchTimer = setTimeout(() => void this.fetchBrowseResults(), 350);
    });

    // Keep focus when re-rendering
    setTimeout(() => {
      const el = this.listEl.querySelector<HTMLInputElement>('.ct-skills-search');
      if (el && document.activeElement !== el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, 0);

    const inner = this.listEl.createEl('div', { cls: 'ct-skills-list-inner' });

    // ── Search active ────────────────────────────────────────────────────────
    if (this.browseQuery.length >= 2) {
      if (this.isBrowseLoading) {
        const loading = inner.createEl('div', { cls: 'ct-skills-empty' });
        loading.createEl('span', { cls: 'ct-skills-spinner' });
        loading.createEl('span', { text: ' Searching…' });
        return;
      }
      if (this.browseResults.length === 0) {
        inner.createEl('div', { cls: 'ct-skills-empty', text: `No results for "${this.browseQuery}"` });
        return;
      }
      this.renderSkillCards(inner, this.browseResults);
      return;
    }

    // ── No query — show popular list ─────────────────────────────────────────
    if (this.isPopularLoading) {
      const loading = inner.createEl('div', { cls: 'ct-skills-empty' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading popular skills…' });
      return;
    }

    if (this.browsePopularResults.length > 0) {
      inner.createEl('div', { cls: 'ct-skills-section-label', text: 'Popular' });
      this.renderSkillCards(inner, this.browsePopularResults);
      return;
    }

    inner.createEl('div', { cls: 'ct-skills-empty', text: 'Type to search skills.sh' });
  }

  private renderLocalBrowseList(): void {
    const inner = this.listEl.createEl('div', { cls: 'ct-skills-list-inner' });

    if (this.isLocalSkillsLoading) {
      const loading = inner.createEl('div', { cls: 'ct-skills-empty' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading skills…' });
      return;
    }

    if (this.localSkills.length === 0) {
      inner.createEl('div', { cls: 'ct-skills-empty', text: 'No skills found in this source' });
      return;
    }

    for (const skill of this.localSkills) {
      const isActive = this.selectedLocalSkill?.id === skill.id;
      const card = inner.createEl('div', {
        cls: 'ct-skills-card' + (isActive ? ' ct-skills-card--active' : ''),
      });

      const main = card.createEl('div', { cls: 'ct-skills-card-main' });
      main.createEl('div', { cls: 'ct-skills-card-name', text: skill.name });
      if (skill.description) {
        main.createEl('div', { cls: 'ct-skills-card-desc', text: skill.description });
      }

      if (skill.isLinked) {
        card.createEl('span', { cls: 'ct-skills-badge', text: 'linked' });
      }

      card.addEventListener('click', () => {
        this.selectedLocalSkill = skill;
        this.renderList();
        this.renderDetail();
      });
    }
  }

  /** Render a list of browse skill cards into the given container. */
  private renderSkillCards(container: HTMLElement, skills: BrowseSkill[]): void {
    for (const skill of skills) {
      const isActive = this.selectedBrowse?.slug === skill.slug;
      const card = container.createEl('div', {
        cls: 'ct-skills-card' + (isActive ? ' ct-skills-card--active' : ''),
      });

      const main = card.createEl('div', { cls: 'ct-skills-card-main' });
      main.createEl('div', { cls: 'ct-skills-card-name', text: skill.name });
      if (skill.source) {
        main.createEl('div', { cls: 'ct-skills-card-desc', text: skill.source });
      }

      const meta = card.createEl('div', { cls: 'ct-skills-card-meta' });
      if (skill.installs > 0) {
        meta.createEl('span', { cls: 'ct-skills-installs', text: formatInstalls(skill.installs) });
      }
      if (skill.isInstalled) {
        meta.createEl('span', { cls: 'ct-skills-badge ct-skills-badge--installed', text: 'installed' });
      }

      card.addEventListener('click', () => {
        this.selectedBrowse = skill;
        this.renderList();
        this.renderDetail();
        void this.fetchSkillDescription(skill);
      });
    }
  }

  // ── Detail Panel ───────────────────────────────────────────────────────────

  private renderDetail(): void {
    this.detailEl.empty();
    if (this.activeTab === 'installed') {
      this.renderInstalledDetail();
    } else if (this.browseSource !== 'registry') {
      this.renderLocalDetail();
    } else {
      this.renderBrowseDetail();
    }
  }

  private renderInstalledDetail(): void {
    // If an agent is selected, show its detail
    if (this.selectedAgent) {
      this.renderAgentDetail(this.selectedAgent);
      return;
    }

    // If a github source plugin is selected, show its detail
    if (this.selectedGithubSource) {
      this.renderGithubPluginDetail(this.selectedGithubSource);
      return;
    }

    const skill = this.selectedInstalled;

    if (!skill) {
      const empty = this.detailEl.createEl('div', { cls: 'ct-skills-detail-empty' });
      const iconEl = empty.createEl('div', { cls: 'ct-skills-detail-empty-icon' });
      setIcon(iconEl, 'puzzle');
      empty.createEl('div', { text: 'Select a skill to view and edit' });
      return;
    }

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });

    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    const pathText = skill.isSymlink
      ? `${skill.skillPath} → ${skill.realPath}`
      : skill.realPath;
    pathRow.createEl('span', { text: pathText, cls: 'ct-skills-detail-path-text' });

    // Editor section
    const editorWrap = this.detailEl.createEl('div', { cls: 'ct-skills-editor-wrap' });
    const labelRow = editorWrap.createEl('div', { cls: 'ct-skills-editor-label' });
    labelRow.createEl('span', { text: 'SKILL.md' });
    if (this.isDirty) {
      labelRow.createEl('span', { cls: 'ct-skills-dirty-dot', text: '●', attr: { title: 'Unsaved changes' } });
    }

    const textarea = editorWrap.createEl('textarea', { cls: 'ct-skills-textarea' });
    textarea.value = this.editContent;
    textarea.addEventListener('input', () => {
      this.editContent = textarea.value;
      this.isDirty = this.editContent !== skill.content;
      // Patch dirty indicator without a full re-render
      const dot = this.detailEl.querySelector('.ct-skills-dirty-dot');
      if (this.isDirty && !dot) {
        const lbl = this.detailEl.querySelector('.ct-skills-editor-label');
        lbl?.createEl('span', { cls: 'ct-skills-dirty-dot', text: '●', attr: { title: 'Unsaved changes' } });
      } else if (!this.isDirty && dot) {
        dot.remove();
      }
      const saveBtn = this.detailEl.querySelector<HTMLButtonElement>('.ct-skills-btn-save');
      if (saveBtn) saveBtn.disabled = !this.isDirty;
    });

    // Primary actions
    const actions = this.detailEl.createEl('div', { cls: 'ct-skills-actions' });

    const saveBtn = actions.createEl('button', {
      cls: 'ct-skills-btn ct-skills-btn--primary ct-skills-btn-save',
      text: 'Save',
      attr: { disabled: this.isDirty ? null : 'true' },
    });
    saveBtn.disabled = !this.isDirty;
    saveBtn.addEventListener('click', () => void this.saveSkillContent(skill, textarea));

    const revealBtn = actions.createEl('button', {
      cls: 'ct-skills-btn',
      text: 'Reveal in Finder',
    });
    revealBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { showItemInFolder: (path: string) => void } };
      electron.shell?.showItemInFolder(skill.skillMdPath);
    });

    // Reload button (re-reads file from disk)
    const reloadBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reload' });
    reloadBtn.addEventListener('click', () => void this.reloadSkillContent(skill));

    // Danger zone
    const danger = this.detailEl.createEl('div', { cls: 'ct-skills-danger-zone' });
    const uninstallBtn = danger.createEl('button', {
      cls: 'ct-skills-btn ct-skills-btn--danger',
      text: 'Uninstall',
    });
    uninstallBtn.addEventListener('click', () => void this.uninstallSkill(skill));
  }

  private renderAgentDetail(agent: InstalledAgent): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: agent.name });

    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    pathRow.createEl('span', { text: agent.agentPath, cls: 'ct-skills-detail-path-text' });

    // Editor section
    const editorWrap = this.detailEl.createEl('div', { cls: 'ct-skills-editor-wrap' });
    const labelRow = editorWrap.createEl('div', { cls: 'ct-skills-editor-label' });
    labelRow.createEl('span', { text: `agents/${path.basename(agent.agentPath)}` });
    if (this.isAgentDirty) {
      labelRow.createEl('span', { cls: 'ct-skills-dirty-dot', text: '●', attr: { title: 'Unsaved changes' } });
    }

    const textarea = editorWrap.createEl('textarea', { cls: 'ct-skills-textarea' });
    textarea.value = this.agentEditContent;
    textarea.addEventListener('input', () => {
      this.agentEditContent = textarea.value;
      this.isAgentDirty = this.agentEditContent !== agent.content;
      // Patch dirty indicator without a full re-render
      const dot = this.detailEl.querySelector('.ct-skills-dirty-dot');
      if (this.isAgentDirty && !dot) {
        const lbl = this.detailEl.querySelector('.ct-skills-editor-label');
        lbl?.createEl('span', { cls: 'ct-skills-dirty-dot', text: '●', attr: { title: 'Unsaved changes' } });
      } else if (!this.isAgentDirty && dot) {
        dot.remove();
      }
      const saveBtn = this.detailEl.querySelector<HTMLButtonElement>('.ct-skills-btn-save');
      if (saveBtn) saveBtn.disabled = !this.isAgentDirty;
    });

    // Primary actions
    const actions = this.detailEl.createEl('div', { cls: 'ct-skills-actions' });

    const saveBtn = actions.createEl('button', {
      cls: 'ct-skills-btn ct-skills-btn--primary ct-skills-btn-save',
      text: 'Save',
      attr: { disabled: this.isAgentDirty ? null : 'true' },
    });
    saveBtn.disabled = !this.isAgentDirty;
    saveBtn.addEventListener('click', () => void this.saveAgentContent(agent, textarea));

    const reloadBtn = actions.createEl('button', { cls: 'ct-skills-btn', text: 'Reload' });
    reloadBtn.addEventListener('click', () => void this.reloadAgentContent(agent));

    const revealBtn = actions.createEl('button', {
      cls: 'ct-skills-btn',
      text: 'Reveal in Finder',
    });
    revealBtn.addEventListener('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { showItemInFolder: (path: string) => void } };
      electron.shell?.showItemInFolder(agent.agentPath);
    });

    // Danger zone
    const danger = this.detailEl.createEl('div', { cls: 'ct-skills-danger-zone' });
    const deleteBtn = danger.createEl('button', {
      cls: 'ct-skills-btn ct-skills-btn--danger',
      text: 'Delete',
    });
    deleteBtn.addEventListener('click', () => {
      new ConfirmModal(
        this.app,
        `Delete "${agent.name}" from ~/.claude/agents/? This cannot be undone.`,
        'Delete',
        (confirmed) => { if (confirmed) void this.doDeleteAgent(agent); },
      ).open();
    });
  }

  private async saveAgentContent(agent: InstalledAgent, textarea: HTMLTextAreaElement): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      await fs.promises.writeFile(agent.agentPath, this.agentEditContent, 'utf-8');
      agent.content = this.agentEditContent;
      this.isAgentDirty = false;
      new Notice(`Saved ${agent.name}`);
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to save: ${String(err)}`);
    }
  }

  private async reloadAgentContent(agent: InstalledAgent): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      const content = await fs.promises.readFile(agent.agentPath, 'utf-8');
      agent.content = content;
      this.agentEditContent = content;
      this.isAgentDirty = false;
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to reload: ${String(err)}`);
    }
  }

  private async doDeleteAgent(agent: InstalledAgent): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      await fs.promises.unlink(agent.agentPath);
      new Notice(`Deleted ${agent.name}`);
      this.installedAgents = this.installedAgents.filter((a) => a.name !== agent.name);
      if (this.selectedAgent?.name === agent.name) {
        this.selectedAgent = null;
        this.agentEditContent = '';
        this.isAgentDirty = false;
      }
      this.renderList();
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to delete: ${String(err)}`);
    }
  }

  private renderGithubPluginDetail(source: import('./types').SkillSource): void {
    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: source.name });

    if (source.repoUrl) {
      const urlRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
      const link = urlRow.createEl('a', {
        cls: 'ct-skills-source-link',
        text: source.repoUrl,
        href: source.repoUrl,
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
        electron.shell?.openExternal(source.repoUrl!);
      });
    }

    if (source.lastFetched) {
      header.createEl('div', {
        cls: 'ct-skills-meta-line',
        text: `Last checked: ${new Date(source.lastFetched).toLocaleString()}`,
      });
    }

    // Staleness + Update
    const actions = this.detailEl.createEl('div', { cls: 'ct-skills-actions' });
    if (source.behindCount && source.behindCount > 0) {
      actions.createEl('span', {
        cls: 'ct-skills-badge--updates',
        text: `• ${source.behindCount} update${source.behindCount > 1 ? 's' : ''} available`,
      });
      const updateBtn = actions.createEl('button', { cls: 'ct-skills-btn ct-skills-btn--primary', text: 'Update' });
      updateBtn.addEventListener('click', () => void this.updateGithubSource(source));
    } else if (source.behindCount === 0) {
      actions.createEl('span', { cls: 'ct-skills-meta-line', text: 'Up to date' });
    }

    // Skills list
    const skillsSection = this.detailEl.createEl('div', { cls: 'ct-skills-desc-section' });
    skillsSection.createEl('div', { cls: 'ct-skills-section-label', text: 'Skills' });

    if (this.isGithubSourceSkillsLoading) {
      const loading = skillsSection.createEl('div', { cls: 'ct-skills-desc-loading' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading…' });
    } else if (this.githubSourceSkills.length === 0) {
      skillsSection.createEl('div', { cls: 'ct-skills-empty', text: 'No skills found' });
    } else {
      const list = skillsSection.createEl('div', { cls: 'ct-skills-plugin-skill-list' });
      for (const skill of this.githubSourceSkills) {
        const row = list.createEl('div', { cls: 'ct-skills-plugin-skill-row' });
        row.createEl('span', { cls: 'ct-skills-plugin-skill-name', text: skill.name });
        if (skill.description) {
          row.createEl('span', { cls: 'ct-skills-plugin-skill-desc', text: skill.description });
        }
      }
    }

    // Remove
    const footer = this.detailEl.createEl('div', { cls: 'ct-skills-browse-footer' });
    const removeBtn = footer.createEl('button', { cls: 'ct-skills-btn ct-skills-btn--danger', text: 'Remove Source' });
    removeBtn.addEventListener('click', () => {
      new ConfirmModal(
        this.app,
        `Remove "${source.name}"? This will delete the local clone and unregister it from Claude Code.`,
        'Remove',
        (confirmed) => { if (confirmed) void this.doRemoveGithubSource(source); },
      ).open();
    });
  }

  private async loadGithubSourceSkillsForInstalled(source: import('./types').SkillSource): Promise<void> {
    if (!source.clonePath) return;
    this.isGithubSourceSkillsLoading = true;
    this.renderDetail();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const { getSkillsDirForSource } = await import('./claudeSettings');

    const skillsDir = getSkillsDirForSource(source.clonePath);
    const skills: LocalSkill[] = [];

    try {
      const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(skillsDir, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        try { await fs.promises.access(skillMdPath); } catch { continue; }
        let content = '';
        try { content = await fs.promises.readFile(skillMdPath, 'utf-8'); } catch { /* empty */ }
        const { name, description } = parseFrontmatter(content);
        skills.push({ id: entry.name, name: name || entry.name, description, skillsPath: skillsDir, skillDir, isLinked: false, isGithubSource: true });
      }
    } catch { /* ignore */ }

    // Only update if this source is still selected
    if (this.selectedGithubSource?.id === source.id) {
      this.githubSourceSkills = skills.sort((a, b) => a.name.localeCompare(b.name));
      this.isGithubSourceSkillsLoading = false;
      this.renderDetail();
    }
  }

  private async doRemoveGithubSource(source: import('./types').SkillSource): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');

    if (source.clonePath) {
      try { fs.rmSync(source.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    this.plugin.settings.skillSources = this.plugin.settings.skillSources.filter(s => s.id !== source.id);
    await this.plugin.saveSettings();
    this.selectedGithubSource = null;
    this.githubSourceSkills = [];
    new Notice(`Removed ${source.name}`);
    await this.loadInstalledSkills();
    this.renderList();
    this.renderDetail();
  }

  private renderBrowseDetail(): void {
    const skill = this.selectedBrowse;

    if (!skill) {
      const empty = this.detailEl.createEl('div', { cls: 'ct-skills-detail-empty' });
      const iconEl = empty.createEl('div', { cls: 'ct-skills-detail-empty-icon' });
      setIcon(iconEl, 'globe');
      empty.createEl('div', { text: 'Search and select a skill to install' });
      return;
    }

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });

    if (skill.source) {
      const sourceEl = header.createEl('div', { cls: 'ct-skills-detail-path' });
      const link = sourceEl.createEl('a', {
        cls: 'ct-skills-source-link',
        text: skill.source,
        href: `https://github.com/${skill.source}`,
        attr: { target: '_blank' },
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
        electron.shell?.openExternal(`https://github.com/${skill.source}`);
      });
    }

    if (skill.installs > 0) {
      header.createEl('div', {
        cls: 'ct-skills-meta-line',
        text: formatInstalls(skill.installs),
      });
    }

    // Description / SKILL.md preview
    const descSection = this.detailEl.createEl('div', { cls: 'ct-skills-desc-section' });
    if (this.browseDescLoading.has(skill.slug)) {
      const loading = descSection.createEl('div', { cls: 'ct-skills-desc-loading' });
      loading.createEl('span', { cls: 'ct-skills-spinner' });
      loading.createEl('span', { text: ' Loading description…' });
    } else if (this.browseDescriptions.has(skill.slug)) {
      const descText = this.browseDescriptions.get(skill.slug);
      if (descText) {
        descSection.createEl('p', { cls: 'ct-skills-desc-text', text: descText });
      }
    }

    // Install area
    const installArea = this.detailEl.createEl('div', { cls: 'ct-skills-install-area' });

    if (skill.isInstalled) {
      const badge = installArea.createEl('div', { cls: 'ct-skills-installed-badge' });
      const iconEl = badge.createEl('span', { cls: 'ct-skills-installed-icon' });
      setIcon(iconEl, 'check-circle');
      badge.createEl('span', { text: 'Already installed' });
    } else if (this.installingSlug === skill.slug) {
      const progress = installArea.createEl('div', { cls: 'ct-skills-install-progress' });
      progress.createEl('span', { cls: 'ct-skills-spinner' });
      progress.createEl('span', { text: ' Installing…' });
      if (this.installOutput) {
        installArea.createEl('pre', { cls: 'ct-skills-install-output', text: this.installOutput });
      }
    } else {
      const installBtn = installArea.createEl('button', {
        cls: 'ct-skills-btn ct-skills-btn--primary',
        text: 'Install',
      });
      installBtn.addEventListener('click', () => void this.installSkill(skill));
    }

    // skills.sh link
    const footer = this.detailEl.createEl('div', { cls: 'ct-skills-browse-footer' });
    const viewLink = footer.createEl('a', {
      cls: 'ct-skills-link',
      text: `View on skills.sh ↗`,
      href: `https://skills.sh/${skill.slug}`,
    });
    viewLink.addEventListener('click', (e) => {
      e.preventDefault();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
      electron.shell?.openExternal(`https://skills.sh/${skill.slug}`);
    });
  }

  // ── Local Source Detail ────────────────────────────────────────────────────

  private renderLocalDetail(): void {
    const skill = this.selectedLocalSkill;

    if (!skill) {
      const empty = this.detailEl.createEl('div', { cls: 'ct-skills-detail-empty' });
      const iconEl = empty.createEl('div', { cls: 'ct-skills-detail-empty-icon' });
      setIcon(iconEl, 'folder-open');
      empty.createEl('div', { text: 'Select a skill to view' });
      return;
    }

    // Find the source so we can check for repoPath
    const sources = this.plugin.settings.skillSources ?? [];
    const source = sources.find((s) => s.id === this.browseSource) ?? null;

    // Header
    const header = this.detailEl.createEl('div', { cls: 'ct-skills-detail-header' });
    header.createEl('div', { cls: 'ct-skills-detail-name', text: skill.name });
    const pathRow = header.createEl('div', { cls: 'ct-skills-detail-path' });
    pathRow.createEl('span', { text: skill.skillDir, cls: 'ct-skills-detail-path-text' });

    // Description
    if (skill.description) {
      const descSection = this.detailEl.createEl('div', { cls: 'ct-skills-desc-section' });
      descSection.createEl('p', { cls: 'ct-skills-desc-text', text: skill.description });
    }

    // Install area
    const installArea = this.detailEl.createEl('div', { cls: 'ct-skills-install-area' });

    if (skill.isLinked) {
      const badge = installArea.createEl('div', { cls: 'ct-skills-installed-badge' });
      const iconEl = badge.createEl('span', { cls: 'ct-skills-installed-icon' });
      setIcon(iconEl, 'check-circle');
      badge.createEl('span', { text: 'Already linked' });
    } else {
      const linkBtn = installArea.createEl('button', {
        cls: 'ct-skills-btn ct-skills-btn--primary',
        text: 'Link',
      });
      linkBtn.addEventListener('click', () => void this.linkLocalSkill(skill));
    }

    // Pull Updates button (local sources only, if source has repoPath)
    if (source?.repoPath) {
      const actions = this.detailEl.createEl('div', { cls: 'ct-skills-actions' });
      const pullBtn = actions.createEl('button', {
        cls: 'ct-skills-btn',
        text: 'Pull Updates',
      });
      pullBtn.addEventListener('click', () => this.pullSourceUpdates(source));
    }
  }

  private async updateGithubSource(source: import('./types').SkillSource): Promise<void> {
    if (!source.clonePath) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    try {
      execSync(`git -C "${source.clonePath}" pull`, { stdio: 'pipe', timeout: 60_000 });
      source.behindCount = 0;
      source.lastFetched = Date.now();
      await this.plugin.saveSettings();
      new Notice(`Updated ${source.name}`);
      this.githubSourceSkills = [];
      void this.loadGithubSourceSkillsForInstalled(source);
      await this.loadInstalledSkills(); // refresh individual skills list too
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Update failed: ${msg}`);
    }
  }

  private async linkLocalSkill(skill: LocalSkill): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const linkPath = path.join(os.homedir(), '.claude', 'skills', skill.id);
    try {
      await fs.promises.symlink(skill.skillDir, linkPath);
      skill.isLinked = true;
      new Notice(`Linked ${skill.name}`);
      void this.loadInstalledSkills();
      this.renderList();
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to link: ${String(err)}`);
    }
  }

  private pullSourceUpdates(source: import('./types').SkillSource): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const expandedRepoPath = (source.repoPath ?? '').replace(/^~/, os.homedir());
    try {
      const output = execSync(`git -C "${expandedRepoPath}" pull`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      const stdout = output.toString().trim();
      new Notice(`Pull succeeded: ${stdout.slice(0, 100)}`);
      // Reload local skill list to reflect any new/removed skills
      void this.loadLocalSkills(source.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Pull failed: ${msg}`);
    }
  }

  /** Scan a local source directory for skills containing SKILL.md. */
  private async loadLocalSkills(sourceId: string): Promise<void> {
    const sources = this.plugin.settings.skillSources ?? [];
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    this.isLocalSkillsLoading = true;
    this.renderList();

    let skillsDir: string;
    let isGithubSource = false;

    if (source.type === 'github' && source.clonePath) {
      isGithubSource = true;
      const { getSkillsDirForSource } = await import('./claudeSettings');
      skillsDir = getSkillsDirForSource(source.clonePath);
    } else {
      // local type
      const rawPath = source.skillsPath ?? '';
      skillsDir = rawPath.replace(/^~/, os.homedir());
    }

    const skills: LocalSkill[] = [];

    try {
      const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(skillsDir, entry.name);

        // Check if SKILL.md exists
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        try {
          await fs.promises.access(skillMdPath);
        } catch {
          continue; // no SKILL.md, skip
        }

        let content = '';
        try {
          content = await fs.promises.readFile(skillMdPath, 'utf-8');
        } catch { /* keep empty */ }

        const { name, description } = parseFrontmatter(content);

        const isLinked = isGithubSource
          ? false
          : fs.existsSync(path.join(os.homedir(), '.claude', 'skills', entry.name));

        skills.push({
          id: entry.name,
          name: name || entry.name,
          description,
          skillsPath: skillsDir,
          skillDir,
          isLinked,
          isGithubSource,
        });
      }
    } catch (err) {
      console.warn('[ClaudeThreads] Could not load local skills:', err);
    }

    this.localSkills = skills.sort((a, b) => a.name.localeCompare(b.name));
    this.isLocalSkillsLoading = false;

    // Keep selection in sync
    if (this.selectedLocalSkill) {
      const refreshed = this.localSkills.find((s) => s.id === this.selectedLocalSkill!.id);
      this.selectedLocalSkill = refreshed ?? null;
    }

    this.renderList();
    this.renderDetail();
  }

  // ── Skill Description Fetch ───────────────────────────────────────────────

  /** Fetch the description from SKILL.md for a browse skill, caching the result. */
  private async fetchSkillDescription(skill: BrowseSkill): Promise<void> {
    if (this.browseDescriptions.has(skill.slug) || this.browseDescLoading.has(skill.slug)) {
      return;
    }
    if (!skill.source) {
      this.browseDescriptions.set(skill.slug, null);
      return;
    }

    this.browseDescLoading.add(skill.slug);
    if (this.selectedBrowse?.slug === skill.slug) this.renderDetail();

    // Derive the skill's own ID (last path segment after removing the source prefix)
    const skillId = skill.slug.startsWith(skill.source + '/')
      ? skill.slug.slice(skill.source.length + 1)
      : skill.slug;

    // Try common SKILL.md locations in the repo, in order
    const candidates = [
      `https://raw.githubusercontent.com/${skill.source}/main/skills/${skillId}/SKILL.md`,
      `https://raw.githubusercontent.com/${skill.source}/main/${skillId}/SKILL.md`,
      `https://raw.githubusercontent.com/${skill.source}/main/SKILL.md`,
    ];

    let description: string | null = null;
    for (const url of candidates) {
      try {
        const res = await requestUrl({ url, method: 'GET', throw: false });
        if (res.status === 200 && res.text) {
          const { description: fm } = parseFrontmatter(res.text);
          if (fm) {
            description = fm.replace(/^["']|["']$/g, '');
            break;
          }
          // No frontmatter description — try first non-heading, non-empty paragraph
          const lines = res.text.split('\n');
          const start = lines.findIndex((l) => l.startsWith('---')) >= 0
            ? lines.findIndex((l, i) => i > 0 && l.startsWith('---')) + 1
            : 0;
          const body = lines.slice(start).join('\n');
          const para = body.match(/(?:^|\n)(?!#|\s*```)[^\n]{20,}/m);
          if (para) {
            description = para[0].trim();
            break;
          }
        }
      } catch { /* try next */ }
    }

    this.browseDescLoading.delete(skill.slug);
    this.browseDescriptions.set(skill.slug, description);
    if (this.selectedBrowse?.slug === skill.slug) this.renderDetail();
  }

  // ── Data Loading ──────────────────────────────────────────────────────────

  async loadInstalledSkills(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const skillsDir = path.join(os.homedir(), '.claude', 'skills');

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
    } catch (err) {
      console.warn('[ClaudeThreads] Could not read skills dir:', err);
      this.installedSkills = [];
      this.renderList();
      this.renderDetail();
      return;
    }

    const skills: InstalledSkill[] = [];

    for (const entry of entries) {
      const skillPath = path.join(skillsDir, entry.name);

      try {
        const isSymlink = entry.isSymbolicLink();
        let realPath = skillPath;
        if (isSymlink) {
          try {
            realPath = await fs.promises.realpath(skillPath);
          } catch {
            realPath = skillPath;
          }
        }

        const stat = await fs.promises.stat(skillPath);
        const isDirectory = stat.isDirectory();

        // Determine where SKILL.md lives
        let skillMdPath: string;
        if (isDirectory) {
          skillMdPath = path.join(realPath, 'SKILL.md');
        } else if (entry.name.endsWith('.md')) {
          skillMdPath = realPath;
        } else {
          continue; // skip non-.md non-directory entries
        }

        let content = '';
        try {
          content = await fs.promises.readFile(skillMdPath, 'utf-8');
        } catch {
          // SKILL.md missing — keep empty content
        }

        const { name, description } = parseFrontmatter(content);

        skills.push({
          name: name || entry.name.replace(/\.md$/, ''),
          description,
          skillPath,
          realPath,
          isSymlink,
          isDirectory,
          skillMdPath,
          content,
        });
      } catch (err) {
        console.warn(`[ClaudeThreads] Skipping skill entry "${entry.name}":`, err);
      }
    }

    this.installedSkills = skills.sort((a, b) => a.name.localeCompare(b.name));

    // Compute sourceName for symlinked skills by matching against configured SkillSources
    const skillSources = this.plugin.settings.skillSources ?? [];
    if (skillSources.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const osModule = require('os') as typeof import('os');
      for (const skill of this.installedSkills) {
        if (!skill.isSymlink) continue;
        for (const source of skillSources) {
          const sourcePath = source.type === 'github' ? source.clonePath : (source.skillsPath ?? '');
          const expandedSourcePath = (sourcePath ?? '').replace(/^~/, osModule.homedir());
          if (expandedSourcePath && skill.realPath.startsWith(expandedSourcePath)) {
            skill.sourceName = source.name;
            break;
          }
        }
      }
    }

    // Keep selected skill in sync after reload
    if (this.selectedInstalled) {
      const refreshed = this.installedSkills.find((s) => s.name === this.selectedInstalled!.name);
      if (refreshed) {
        this.selectedInstalled = refreshed;
        if (!this.isDirty) this.editContent = refreshed.content;
      } else {
        this.selectedInstalled = null;
      }
    }

    this.renderList();
    this.renderDetail();
  }

  async loadInstalledAgents(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const agentsDir = path.join(os.homedir(), '.claude', 'agents');
    const agents: InstalledAgent[] = [];

    try {
      const entries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.endsWith('.md')) continue;
        const agentPath = path.join(agentsDir, entry.name);
        let content = '';
        try { content = await fs.promises.readFile(agentPath, 'utf-8'); } catch { /* skip */ }
        const { name, description } = parseFrontmatter(content);
        agents.push({
          name: name || entry.name.replace(/\.md$/, ''),
          description,
          agentPath,
          content,
        });
      }
    } catch {
      // agents dir may not exist — ignore
    }

    this.installedAgents = agents.sort((a, b) => a.name.localeCompare(b.name));

    // Keep selection in sync after reload
    if (this.selectedAgent) {
      const refreshed = this.installedAgents.find(a => a.name === this.selectedAgent!.name);
      if (refreshed) {
        this.selectedAgent = refreshed;
        if (!this.isAgentDirty) this.agentEditContent = refreshed.content;
      } else {
        this.selectedAgent = null;
      }
    }
  }

  private async fetchBrowseResults(): Promise<void> {
    if (!this.browseQuery || this.browseQuery.length < 2) {
      this.browseResults = [];
      this.isBrowseLoading = false;
      this.renderList();
      return;
    }

    try {
      const res = await requestUrl({
        url: `https://skills.sh/api/search?q=${encodeURIComponent(this.browseQuery)}&limit=15`,
        method: 'GET',
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

      const data = res.json as {
        skills: Array<{ id: string; skillId?: string; name: string; installs: number; source: string }>;
      };

      const installedNames = new Set(this.installedSkills.map((s) => s.name));
      const installedSlugs = new Set(
        this.installedSkills.map((s) => s.skillPath.split('/').pop() ?? ''),
      );

      this.browseResults = (data.skills ?? [])
        .map((s) => {
          const skillId = s.skillId || s.id.split('/').pop() || s.id;
          return {
            name: s.name,
            slug: s.id,
            skillId,
            source: s.source ?? '',
            installs: s.installs ?? 0,
            isInstalled: installedNames.has(s.name) || installedSlugs.has(skillId),
          };
        })
        .sort((a, b) => b.installs - a.installs);
    } catch (err) {
      console.error('[ClaudeThreads] Skills search error:', err);
      this.browseResults = [];
    } finally {
      this.isBrowseLoading = false;
      this.renderList();
    }
  }

  /** Fetch a popular-skills list shown when the Browse tab opens with no query. */
  private async fetchPopularSkills(): Promise<void> {
    this.isPopularLoading = true;
    this.renderList();

    try {
      const res = await requestUrl({
        url: 'https://skills.sh/api/search?q=er&limit=30',
        method: 'GET',
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

      const data = res.json as {
        skills: Array<{ id: string; skillId?: string; name: string; installs: number; source: string }>;
      };

      const installedNames = new Set(this.installedSkills.map((s) => s.name));
      const installedSlugs = new Set(
        this.installedSkills.map((s) => s.skillPath.split('/').pop() ?? ''),
      );

      this.browsePopularResults = (data.skills ?? [])
        .map((s) => {
          const skillId = s.skillId || s.id.split('/').pop() || s.id;
          return {
            name: s.name,
            slug: s.id,
            skillId,
            source: s.source ?? '',
            installs: s.installs ?? 0,
            isInstalled: installedNames.has(s.name) || installedSlugs.has(skillId),
          };
        })
        .sort((a, b) => b.installs - a.installs);
    } catch (err) {
      console.error('[ClaudeThreads] Skills popular fetch error:', err);
      this.browsePopularResults = [];
    } finally {
      this.isPopularLoading = false;
      this.renderList();
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private async saveSkillContent(skill: InstalledSkill, textarea: HTMLTextAreaElement): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      await fs.promises.writeFile(skill.skillMdPath, this.editContent, 'utf-8');
      skill.content = this.editContent;
      this.isDirty = false;
      new Notice(`Saved ${skill.name}`);
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to save: ${String(err)}`);
    }
  }

  private async reloadSkillContent(skill: InstalledSkill): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      const content = await fs.promises.readFile(skill.skillMdPath, 'utf-8');
      skill.content = content;
      this.editContent = content;
      this.isDirty = false;
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to reload: ${String(err)}`);
    }
  }

  private uninstallSkill(skill: InstalledSkill): void {
    new ConfirmModal(
      this.app,
      `Remove "${skill.name}" from ~/.claude/skills/? This cannot be undone.`,
      'Uninstall',
      (confirmed) => {
        if (confirmed) void this.doUninstall(skill);
      },
    ).open();
  }

  private async doUninstall(skill: InstalledSkill): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    try {
      await fs.promises.rm(skill.skillPath, { recursive: true, force: true });
      new Notice(`Uninstalled ${skill.name}`);
      this.installedSkills = this.installedSkills.filter((s) => s.name !== skill.name);
      if (this.selectedInstalled?.name === skill.name) {
        this.selectedInstalled = null;
        this.editContent = '';
        this.isDirty = false;
      }
      this.renderList();
      this.renderDetail();
    } catch (err) {
      new Notice(`Failed to uninstall: ${String(err)}`);
    }
  }

  private async installSkill(skill: BrowseSkill): Promise<void> {
    if (!skill.source) {
      new Notice('No GitHub source available for this skill');
      return;
    }

    this.installingSlug = skill.slug;
    this.installOutput = '';
    this.renderDetail();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    const tmpDir = path.join(os.tmpdir(), `ct-skill-${Date.now()}`);
    const skillsDir = path.join(os.homedir(), '.claude', 'skills');
    const targetDir = path.join(skillsDir, skill.skillId);

    try {
      await fs.promises.mkdir(skillsDir, { recursive: true });

      if (fs.existsSync(targetDir)) {
        throw new Error(`A skill named "${skill.skillId}" is already installed`);
      }

      this.installOutput = `Cloning ${skill.source}…`;
      this.renderDetail();

      execSync(
        `git clone --depth 1 "https://github.com/${skill.source}.git" "${tmpDir}"`,
        { stdio: 'pipe', timeout: 60_000 },
      );

      this.installOutput = 'Locating skill files…';
      this.renderDetail();

      const skillSrcDir = await findSkillDir(tmpDir, skill.skillId, skill.name, fs, path);
      if (!skillSrcDir) {
        throw new Error(`Skill "${skill.skillId}" not found in ${skill.source}`);
      }

      this.installOutput = 'Copying files…';
      this.renderDetail();

      await copySkillFiles(skillSrcDir, targetDir);

      // Remove .git and other dev-only artifacts from root-level installs
      const dotGit = path.join(targetDir, '.git');
      if (fs.existsSync(dotGit)) {
        await fs.promises.rm(dotGit, { recursive: true, force: true });
      }

      new Notice(`Installed ${skill.name}`);

      // Update browse state
      const inResults = this.browseResults.find((s) => s.slug === skill.slug);
      if (inResults) inResults.isInstalled = true;
      const inPopular = this.browsePopularResults.find((s) => s.slug === skill.slug);
      if (inPopular) inPopular.isInstalled = true;
      this.selectedBrowse = { ...skill, isInstalled: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Install failed: ${msg}`);
      console.error('[ClaudeThreads] Skill install failed:', err);
    } finally {
      // Clean up temp dir (best-effort)
      try {
        const fs2 = require('fs') as typeof import('fs');
        if (fs2.existsSync(tmpDir)) {
          await fs2.promises.rm(tmpDir, { recursive: true, force: true });
        }
      } catch { /* ignore */ }

      this.installingSlug = null;
      this.installOutput = '';
      this.renderDetail();
      this.renderList(); // refresh installed count badge

      // Reload installed list in the background
      void this.loadInstalledSkills();
    }
  }

}

// ── Skill Install Helpers ────────────────────────────────────────────────────

/**
 * Copy a skill's source directory to the target install path.
 *
 * `dereference: true` is critical: some skill repos (e.g. nextlevelbuilder/ui-ux-pro-max-skill)
 * contain `data/` and `scripts/` as intra-repo symlinks. Without dereferencing, those symlinks
 * would be copied as-is, pointing into the now-deleted temp clone directory and leaving the
 * installed skill permanently broken.
 *
 * Exported so it can be unit-tested without instantiating the full ItemView.
 */
export async function copySkillFiles(src: string, dest: string): Promise<void> {
  const { cp } = await import('fs/promises');
  await cp(src, dest, { recursive: true, dereference: true });
}

// ── Skill Discovery ──────────────────────────────────────────────────────────

/**
 * Find the directory inside a cloned repo that contains the target skill's SKILL.md.
 * Exported so it can be unit-tested without instantiating the full ItemView.
 */
export async function findSkillDir(
  repoDir: string,
  skillId: string,
  name: string,
  fs: typeof import('fs'),
  path: typeof import('path'),
): Promise<string | null> {
  // 1. Repo root is the skill itself
  if (fs.existsSync(path.join(repoDir, 'SKILL.md'))) {
    return repoDir;
  }

  // 2. Scan for SKILL.md files up to 4 levels deep.
  //    Skip git/CI/dependency junk only — not all dotfile dirs, since some repos
  //    nest skills under `.claude/skills/<skill-id>/` (e.g. the Claude plugin layout).
  const SKIP = new Set(['.git', '.github', '.gitlab', '.vscode', '.idea', 'node_modules']);
  const candidates: string[] = [];
  const scan = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: import('fs').Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      if (!ent.isDirectory()) continue;
      const sub = path.join(dir, ent.name);
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) {
        candidates.push(sub);
      } else {
        scan(sub, depth + 1);
      }
    }
  };
  scan(repoDir, 0);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 3. Multiple candidates: match by directory basename
  const byDir = candidates.find(
    (d) => path.basename(d) === skillId || path.basename(d) === name,
  );
  if (byDir) return byDir;

  // 4. Match by SKILL.md name frontmatter
  for (const dir of candidates) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      const { name: skillName } = parseFrontmatter(raw);
      if (skillName === skillId || skillName === name) return dir;
    } catch { /* skip */ }
  }

  // 5. Fallback: first found
  return candidates[0] ?? null;
}
