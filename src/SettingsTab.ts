import { App, Modal, Notice, Platform, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { PluginSettings, Project, LayoutDensity, ProviderMode, ScheduledItemSchedule } from './types';
import { serializeKey } from './stt';
import { setDebugLogging } from './logger';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the Web Viewer core plugin is enabled.
 * The Web Viewer's internal plugin ID in Obsidian's core plugin registry is "webviewer".
 */
export function isWebViewerEnabled(app: App): boolean {
  type InternalPlugins = { plugins: Record<string, { enabled: boolean }> };
  return (app as unknown as { internalPlugins: InternalPlugins })
    .internalPlugins?.plugins?.['webviewer']?.enabled === true;
}

function generateRoomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatRoomIdAsCode(roomId: string): string {
  // Format as XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 8) {
    groups.push(roomId.slice(i, i + 8).toUpperCase());
  }
  return groups.join('-');
}

function maskOpenAiKey(key: string | null | undefined): string {
  if (!key) return 'No key set';
  if (key.length <= 12) return '••••••••';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

function formatScheduleDescription(schedule: ScheduledItemSchedule): string {
  if (schedule.type === 'interval') {
    const secs = schedule.intervalSeconds ?? 0;
    if (secs >= 86400) return `Every ${Math.round(secs / 86400)} day(s)`;
    if (secs >= 3600) return `Every ${Math.round(secs / 3600)} hour(s)`;
    if (secs >= 60) return `Every ${Math.round(secs / 60)} minute(s)`;
    return `Every ${secs}s`;
  }
  if (schedule.type === 'daily') return `Daily at ${schedule.timeOfDay ?? '?'}`;
  if (schedule.type === 'weekly') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = (schedule.daysOfWeek ?? []).map((d) => dayNames[d] ?? d).join(', ');
    return `Weekly on ${days} at ${schedule.timeOfDay ?? '?'}`;
  }
  return 'Unknown schedule';
}

// ───────────────────────────────────────────────────────────────────────────
// Modals
// ───────────────────────────────────────────────────────────────────────────

/** Modal for entering a new OpenAI API key directly. */
class OpenAiKeyModal extends Modal {
  constructor(app: App, private onSaved: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'OpenAI API key' });
    contentEl.createEl('p', {
      text: 'Paste your API key from platform.openai.com/api-keys',
      cls: 'setting-item-description',
    });

    const input = contentEl.createEl('input', {
      type: 'password',
      placeholder: 'sk-…',
      cls: 'ct-modal-input',
    });

    const buttonRow = contentEl.createDiv('ct-modal-button-row');

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const trimmed = input.value.trim();
      if (!trimmed) return;
      this.app.secretStorage.setSecret('openai-api-key', trimmed);
      this.close();
      this.onSaved();
    });

    // Allow Enter to save
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });

    // Focus the input after the modal animates in
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Modal for adding or changing a secret environment variable.
 * When adding (varName is empty), renders both a name field and a value field.
 * When changing (varName is pre-filled), only asks for the new value.
 */
class SecretEnvModal extends Modal {
  private nameInput: HTMLInputElement | null = null;
  private valueInput: HTMLInputElement | null = null;

  constructor(
    app: App,
    private varName: string,
    private onSave: (value: string, resolvedName: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const isNew = !this.varName;
    contentEl.createEl('h2', { text: isNew ? 'Add secret variable' : `Change: ${this.varName}` });

    if (isNew) {
      contentEl.createEl('p', {
        text: 'The value is stored in the OS keychain and never written to disk.',
        cls: 'setting-item-description',
      });

      contentEl.createEl('label', { text: 'Variable name', cls: 'ct-modal-label' });
      this.nameInput = contentEl.createEl('input', {
        type: 'text',
        placeholder: 'MY_API_KEY',
        cls: 'ct-modal-input ct-modal-input-mono',
      });
    }

    contentEl.createEl('label', {
      text: isNew ? 'Value' : 'New value',
      cls: 'ct-modal-label',
    });
    this.valueInput = contentEl.createEl('input', {
      type: 'password',
      placeholder: isNew ? 'paste your secret here' : 'paste new value',
      cls: 'ct-modal-input',
    });

    const buttonRow = contentEl.createDiv('ct-modal-button-row');

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const val = this.valueInput?.value.trim() ?? '';
      const name = this.varName || (this.nameInput?.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') ?? '');
      if (!val || !name) return;
      this.onSave(val, name);
      this.close();
    });

    const handleEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') saveBtn.click(); };
    this.nameInput?.addEventListener('keydown', handleEnter);
    this.valueInput.addEventListener('keydown', handleEnter);

    setTimeout(() => (this.nameInput ?? this.valueInput)?.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Modal opened when an agent calls the `request_secret` MCP tool.
 * Shows the secret name and the agent's reason for requesting it, collects
 * a password-type value, writes it to the OS keychain, and resolves the
 * promise with true (saved) or false (cancelled).
 */
export class RequestSecretModal extends Modal {
  private valueInput: HTMLInputElement | null = null;
  /** Ensures onSave fires exactly once — guards against double-resolve when
   *  close() is called by a button handler (which already called onSave) and
   *  Obsidian subsequently fires onClose(), or when the user presses Escape. */
  private resolved = false;

  constructor(
    app: App,
    private secretName: string,
    private reason: string,
    private onSave: (saved: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Agent is requesting a secret' });

    const nameRow = contentEl.createDiv({ cls: 'ct-secret-request-name-row' });
    nameRow.createEl('span', { text: 'Variable: ', cls: 'ct-modal-label' });
    nameRow.createEl('code', { text: this.secretName, cls: 'ct-secret-request-name' });

    contentEl.createEl('p', {
      text: `Reason: ${this.reason}`,
      cls: 'setting-item-description',
    });

    contentEl.createEl('p', {
      text: 'The value will be stored in your OS keychain and injected into future sessions. It will never appear in the conversation.',
      cls: 'setting-item-description',
    });

    contentEl.createEl('label', { text: 'Value', cls: 'ct-modal-label' });
    this.valueInput = contentEl.createEl('input', {
      type: 'password',
      placeholder: 'paste your secret here',
      cls: 'ct-modal-input',
    });

    const buttonRow = contentEl.createDiv('ct-modal-button-row');

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.resolved = true;
      this.onSave(false);
      this.close();
    });

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const val = this.valueInput?.value.trim() ?? '';
      if (!val) return;
      this.app.secretStorage.setSecret(`ct-secret-${this.secretName}`, val);
      this.resolved = true;
      this.onSave(true);
      this.close();
    });

    this.valueInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });

    setTimeout(() => this.valueInput?.focus(), 50);
  }

  onClose(): void {
    // Fires on Escape, backdrop click, or after close() — resolve as cancelled
    // if neither button handler has already resolved the promise.
    if (!this.resolved) {
      this.resolved = true;
      this.onSave(false);
    }
    this.contentEl.empty();
  }
}

/** Modal that displays the pairing QR code and alphanumeric code. */
class PairingModal extends Modal {
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(app: App, private plugin: ClaudeThreadsPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ct-pairing-modal');

    const ra = this.plugin.settings.remoteAccess;

    // Set or refresh the 5-minute expiry window when the modal opens.
    ra.pairingExpiresAt = Date.now() + 5 * 60 * 1000;
    this.plugin.saveSettings().catch(console.error);

    // obsidian:// deep link — iOS/Android camera apps will offer "Open in Obsidian"
    // when the user scans this QR code. registerObsidianProtocolHandler('pair', ...)
    // handles obsidian://pair?... on the mobile side.
    const pairingUrl = `obsidian://pair?roomId=${ra.roomId}&relay=${encodeURIComponent(ra.relayUrl)}`;
    const formatted = formatRoomIdAsCode(ra.roomId);

    contentEl.createEl('h2', { text: 'Pair with mobile' });
    contentEl.createEl('p', {
      text: 'Scan this QR code from Obsidian on your mobile device, or enter the code manually in Settings > Remote access.',
      cls: 'ct-pairing-desc',
    });

    const qrContainer = contentEl.createDiv('ct-pairing-qr');

    // Generate QR code asynchronously
    import('qrcode').then((QRCode) => {
      QRCode.toCanvas(pairingUrl, { width: 240, margin: 2 }, (err, canvas) => {
        if (err) {
          qrContainer.createEl('p', { text: 'QR code generation failed. Use the code below.' });
          return;
        }
        qrContainer.appendChild(canvas);
      });
    }).catch(() => {
      qrContainer.createEl('p', { text: 'QR code unavailable. Use the code below.' });
    });

    contentEl.createEl('p', { cls: 'ct-pairing-code-label', text: 'Pairing code:' });
    const codeEl = contentEl.createEl('code', { cls: 'ct-pairing-code', text: formatted });
    codeEl.addEventListener('click', () => {
      navigator.clipboard.writeText(ra.roomId);
      new Notice('Room ID copied to clipboard');
    });

    contentEl.createEl('p', {
      text: 'This code is your room ID. Keep it private — anyone with this code can connect to your desktop.',
      cls: 'ct-pairing-warning',
    });

    // Live countdown label
    const countdownEl = contentEl.createEl('p', { cls: 'ct-pairing-countdown' });

    const updateCountdown = () => {
      const remaining = (ra.pairingExpiresAt ?? 0) - Date.now();
      if (remaining <= 0) {
        this.expire();
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      countdownEl.textContent = `Code expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
    };

    updateCountdown();
    this.countdownTimer = setInterval(updateCountdown, 1000);

    const closeBtn = contentEl.createEl('button', { text: 'Done', cls: 'mod-cta' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.contentEl.empty();
  }

  private expire(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const ra = this.plugin.settings.remoteAccess;
    ra.pairingCode = null;
    ra.pairingExpiresAt = null;
    this.plugin.saveSettings().catch(console.error);
    this.close();
    new Notice('Pairing code expired. Open Settings to generate a new one.');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Settings tab
// ───────────────────────────────────────────────────────────────────────────

type SettingsTabId = 'general' | 'claude' | 'tools' | 'vault' | 'features' | 'remote';

const TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'claude', label: 'Claude' },
  { id: 'tools', label: 'Tools' },
  { id: 'vault', label: 'Vault' },
  { id: 'features', label: 'Features' },
  { id: 'remote', label: 'Remote' },
];

export class ClaudeThreadsSettingTab extends PluginSettingTab {
  /** Survives re-renders (display() is called after toggles, modals, etc.). */
  private activeTab: SettingsTabId = 'general';

  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (Platform.isMobile) {
      this.renderMobileOnlySettings(containerEl);
      return;
    }

    // Tab navigation
    const nav = containerEl.createDiv({ cls: 'ct-settings-tabs' });
    for (const tab of TABS) {
      const btn = nav.createEl('button', {
        text: tab.label,
        cls: 'ct-settings-tab-btn' + (tab.id === this.activeTab ? ' is-active' : ''),
      });
      btn.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.display();
      });
    }

    const body = containerEl.createDiv({ cls: 'ct-settings-tab-body' });
    switch (this.activeTab) {
      case 'general': this.renderGeneralTab(body); break;
      case 'claude': this.renderClaudeTab(body); break;
      case 'tools': this.renderToolsTab(body); break;
      case 'vault': this.renderVaultTab(body); break;
      case 'features': this.renderFeaturesTab(body); break;
      case 'remote': this.renderRemoteTab(body); break;
    }
  }

  // ── General ─────────────────────────────────────────────────────────────

  private renderGeneralTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Layout density')
      .setDesc('How compact the conversation view feels.')
      .addDropdown((drop) =>
        drop
          .addOption('compact', 'Compact')
          .addOption('comfortable', 'Comfortable (default)')
          .addOption('spacious', 'Spacious')
          .setValue(this.plugin.settings.layoutDensity ?? 'comfortable')
          .onChange(async (value) => {
            this.plugin.settings.layoutDensity = value as LayoutDensity;
            await this.plugin.saveSettings();
            this.plugin.getView()?.applyDensity();
          }),
      );

    new Setting(containerEl)
      .setName('Context footer command')
      .setDesc(
        'Shell command that populates the context bar below the input area (git branch, PR, dev URL, …). ' +
        'Receives {cwd, workspace:{current_dir}} as JSON on stdin. Output may be a JSON array of status tags ' +
        '({label, url?, icon?, tone?, kind?}) or legacy plaintext (split on double-spaces). Run per-thread ' +
        'in the background (desktop only); a kind:"pr" tag drives the PR pill. Compatible with the Claude Code ' +
        'statusLine script. Leave empty to disable.',
      )
      .addText((text) => {
        text
          .setPlaceholder('bash $HOME/claude-config/bin/statusline-command.sh')
          .setValue(this.plugin.settings.statusLineCommand)
          .onChange(async (value) => {
            this.plugin.settings.statusLineCommand = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateStatusLineCommand();
          });
        text.inputEl.addClass('ct-settings-wide-input');
      });

    new Setting(containerEl)
      .setName('Keep computer awake')
      .setDesc('Prevent sleep while Claude is responding. Shows ☕ in the status bar when active.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.wakeLockEnabled).onChange(async (value) => {
          this.plugin.settings.wakeLockEnabled = value;
          this.plugin.wakeLock.setEnabled(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Verbose console logs for stream events, session lifecycle, and relay connections. Turn on only when diagnosing issues.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging ?? false).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          setDebugLogging(value);
          await this.plugin.saveSettings();
        }),
      );
  }

  // ── Claude ──────────────────────────────────────────────────────────────

  private renderClaudeTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Claude binary path')
      .setDesc('Path to the claude executable. Leave empty to find it on $PATH.')
      .addText((text) =>
        text
          .setPlaceholder('/opt/homebrew/bin/claude')
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Account / provider')
      .setDesc(
        'Claude account uses the CLI\'s own login. ' +
        'Amazon Bedrock sets CLAUDE_CODE_USE_BEDROCK=1 — also add AWS_PROFILE and AWS_REGION under Extra environment variables.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('claude', 'Claude account (default)')
          .addOption('bedrock', 'Amazon Bedrock')
          .setValue(this.plugin.settings.provider ?? 'claude')
          .onChange(async (value) => {
            this.plugin.settings.provider = value as ProviderMode;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default model')
      .setDesc('Model for new turns unless a thread overrides it with /model. "CLI default" defers to the Claude Code CLI configuration.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('', 'CLI default')
          .addOption('fable', 'Fable 5')
          .addOption('opus', 'Opus')
          .addOption('sonnet', 'Sonnet')
          .addOption('haiku', 'Haiku')
          .setValue(this.plugin.settings.defaultModel ?? '')
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default working directory')
      .setDesc('Starting directory for new threads. Leave empty to use the vault root.')
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getEffectiveCwd())
          .setValue(this.plugin.settings.defaultCwd)
          .onChange(async (value) => {
            this.plugin.settings.defaultCwd = value;
            await this.plugin.saveSettings();
          }),
      );

    // — Environment —
    new Setting(containerEl).setName('Environment').setHeading();

    new Setting(containerEl)
      .setName('Extra environment variables')
      .setDesc('KEY=VALUE pairs (one per line) merged into the Claude process environment.')
      .addTextArea((text) =>
        text
          .setPlaceholder('AWS_PROFILE=my-sso-profile\nAWS_REGION=us-east-1')
          .setValue(this.plugin.settings.extraEnv)
          .onChange(async (value) => {
            this.plugin.settings.extraEnv = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    const secretsList = containerEl.createDiv({ cls: 'ct-secrets-list' });
    const renderSecrets = () => {
      secretsList.empty();
      const keys = this.plugin.settings.secretEnvKeys ?? [];
      if (keys.length === 0) {
        secretsList.createEl('p', { text: 'No secrets configured yet.', cls: 'ct-settings-empty' });
      } else {
        for (const varName of keys) {
          const existingVal = this.plugin.app.secretStorage.getSecret(`ct-secret-${varName}`);
          const maskedVal = existingVal
            ? (existingVal.length <= 8 ? '••••••••' : existingVal.slice(0, 4) + '••••' + existingVal.slice(-4))
            : '(not set)';
          new Setting(secretsList)
            .setName(varName)
            .setDesc(maskedVal)
            .addButton((btn) =>
              btn.setButtonText('Change').onClick(() => {
                new SecretEnvModal(this.app, varName, (newVal) => {
                  this.plugin.app.secretStorage.setSecret(`ct-secret-${varName}`, newVal);
                  renderSecrets();
                }).open();
              }),
            )
            .addButton((btn) =>
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                this.plugin.settings.secretEnvKeys =
                  this.plugin.settings.secretEnvKeys.filter((k) => k !== varName);
                this.plugin.app.secretStorage.setSecret(`ct-secret-${varName}`, '');
                await this.plugin.saveSettings();
                renderSecrets();
              }),
            );
        }
      }
    };

    new Setting(containerEl)
      .setName('Secret environment variables')
      .setDesc('API keys and tokens stored in the OS keychain (never in data.json), injected into every Claude session.')
      .addButton((btn) =>
        btn.setButtonText('Add secret').setCta().onClick(() => {
          new SecretEnvModal(this.app, '', async (val, varName) => {
            if (!varName) return;
            if (!this.plugin.settings.secretEnvKeys.includes(varName)) {
              this.plugin.settings.secretEnvKeys.push(varName);
              await this.plugin.saveSettings();
            }
            this.plugin.app.secretStorage.setSecret(`ct-secret-${varName}`, val);
            renderSecrets();
          }).open();
        }),
      );
    containerEl.appendChild(secretsList);
    renderSecrets();

    // macOS privacy notice
    const macOSNote = containerEl.createDiv({ cls: 'ct-settings-notice' });
    macOSNote.createEl('strong', { text: 'macOS users: ' });
    macOSNote.appendText(
      'The first time Claude accesses a folder like ~/Documents, macOS shows a privacy dialog. ' +
      'Click Allow — it only appears once per folder.',
    );

    // — Model escalation —
    new Setting(containerEl).setName('Model escalation').setHeading();

    new Setting(containerEl)
      .setName('Enable model escalation')
      .setDesc('When the keyword appears in a message, route that single turn to the escalation model. The keyword is stripped before sending.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.escalationEnabled).onChange(async (value) => {
          this.plugin.settings.escalationEnabled = value;
          this.plugin.manager.updateSettings(this.plugin.settings);
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.escalationEnabled) {
      new Setting(containerEl)
        .setName('Escalation keyword')
        .setDesc('Word or phrase that triggers escalation.')
        .addText((text) =>
          text
            .setPlaceholder('/escalate')
            .setValue(this.plugin.settings.escalationKeyword)
            .onChange(async (value) => {
              this.plugin.settings.escalationKeyword = value || '/escalate';
              this.plugin.manager.updateSettings(this.plugin.settings);
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Escalation model')
        .setDesc('Model the escalation keyword routes that turn to.')
        .addDropdown((dropdown) =>
          dropdown
            .addOption('fable', 'Fable 5')
            .addOption('opus', 'Opus')
            .addOption('sonnet', 'Sonnet')
            .addOption('haiku', 'Haiku')
            .setValue(this.plugin.settings.escalationModel || 'opus')
            .onChange(async (value) => {
              this.plugin.settings.escalationModel = value;
              this.plugin.manager.updateSettings(this.plugin.settings);
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  private renderToolsTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Permission mode')
      .setDesc('How Claude handles tool-use permission prompts.')
      .addDropdown((drop) =>
        drop
          .addOption('default', 'Prompt for permissions')
          .addOption('acceptEdits', 'Accept edits automatically')
          .addOption('bypassPermissions', 'Bypass all permissions (trusted directories only)')
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value as PluginSettings['permissionMode'];
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    {
      const wvAvailable = isWebViewerEnabled(this.plugin.app);
      new Setting(containerEl)
        .setName('Web Viewer tool')
        .setDesc(
          wvAvailable
            ? 'Let Claude open URLs directly in the Obsidian Web Viewer panel (obsidian_open_url).'
            : 'Requires the Web Viewer core plugin — enable it under Settings → Core plugins, then reopen this tab.',
        )
        .addToggle((toggle) => {
          toggle
            .setValue(wvAvailable && (this.plugin.settings.enableWebViewerTool ?? true))
            .setDisabled(!wvAvailable)
            .onChange(async (value) => {
              this.plugin.settings.enableWebViewerTool = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName('Hidden built-in tools')
      .setDesc('Comma-separated Claude Code built-in tools to hide from sessions. Cron* tools are hidden by default — the plugin has its own scheduler.')
      .addText((text) =>
        text
          .setPlaceholder('CronCreate, CronDelete, CronList, CronUpdate')
          .setValue(this.plugin.settings.disallowedTools.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.disallowedTools = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    // — Always-allowed tools —
    new Setting(containerEl).setName('Always-allowed tools').setHeading();

    const allowedList = containerEl.createDiv({ cls: 'ct-allowed-tools-list' });
    const renderAllowedTools = () => {
      allowedList.empty();
      const tools = this.plugin.settings.alwaysAllowedTools;
      if (tools.length === 0) {
        allowedList.createEl('p', { text: 'No tools always allowed yet.', cls: 'ct-settings-empty' });
      } else {
        for (const tool of tools) {
          new Setting(allowedList)
            .setName(tool)
            .addButton((btn) =>
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                this.plugin.settings.alwaysAllowedTools =
                  this.plugin.settings.alwaysAllowedTools.filter((t) => t !== tool);
                await this.plugin.saveSettings();
                renderAllowedTools();
              }),
            );
        }
      }
    };

    let newToolInput: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName('Add always-allowed tool')
      .setDesc('Granted automatically without prompting. Tools land here when you choose "Always allow" in a permission prompt; you can also add one by name.')
      .addText((text) => {
        text.setPlaceholder('e.g. Bash, Read, mcp__obsidian__…');
        newToolInput = text.inputEl;
      })
      .addButton((btn) =>
        btn.setButtonText('Add').setCta().onClick(async () => {
          const tool = newToolInput?.value.trim() ?? '';
          if (!tool) return;
          if (!this.plugin.settings.alwaysAllowedTools.includes(tool)) {
            this.plugin.settings.alwaysAllowedTools.push(tool);
            await this.plugin.saveSettings();
            renderAllowedTools();
          }
          if (newToolInput) newToolInput.value = '';
        }),
      );
    containerEl.appendChild(allowedList);
    renderAllowedTools();
  }

  // ── Vault ───────────────────────────────────────────────────────────────

  private renderVaultTab(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Save threads to vault')
      .setDesc('Auto-save conversations as Obsidian notes after each response.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveThreadsToVault).onChange(async (value) => {
          this.plugin.settings.saveThreadsToVault = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Save raw JSONL logs')
      .setDesc('Append each thread\'s raw event stream (tool calls, results, usage) to <vault folder>/logs/<thread id>.jsonl, linked from the note\'s raw_log frontmatter. Lets agents retrieve and analyze the full transcript.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveRawLogs).onChange(async (value) => {
          this.plugin.settings.saveRawLogs = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Vault folder')
      .setDesc('Where thread notes are saved, relative to the vault root.')
      .addText((text) =>
        text
          .setPlaceholder('Claude')
          .setValue(this.plugin.settings.vaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.vaultFolder = value || 'Claude';
            await this.plugin.saveSettings();
          }),
      );

    // — Projects —
    new Setting(containerEl)
      .setName('Projects')
      .setDesc('Projects group threads and scope Claude\'s working directory to a vault sub-folder.')
      .setHeading();

    const projectsListEl = containerEl.createDiv({ cls: 'ct-projects-list' });
    const renderProjects = () => {
      projectsListEl.empty();
      const projects = this.plugin.manager.getProjects();
      if (projects.length === 0) {
        projectsListEl.createEl('p', { text: 'No projects yet.', cls: 'ct-settings-empty' });
      } else {
        for (const project of projects) {
          this.renderProjectRow(projectsListEl, project, renderProjects);
        }
      }
    };
    renderProjects();

    let nameInput: HTMLInputElement | null = null;
    let folderInput: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName('New project')
      .addText((text) => {
        text.setPlaceholder('Project name');
        nameInput = text.inputEl;
      })
      .addText((text) => {
        text.setPlaceholder('Vault folder (e.g. Work/Acme)');
        folderInput = text.inputEl;
      })
      .addButton((btn) =>
        btn.setButtonText('Add').setCta().onClick(async () => {
          const name = nameInput?.value.trim() ?? '';
          const folder = folderInput?.value.trim() ?? '';
          if (!name || !folder) {
            new Notice('Enter both a project name and vault folder.');
            return;
          }
          this.plugin.manager.createProject(name, folder);
          await this.plugin.saveSettings();
          if (nameInput) nameInput.value = '';
          if (folderInput) folderInput.value = '';
          renderProjects();
        }),
      );
  }

  private renderProjectRow(container: HTMLElement, project: Project, refresh: () => void): void {
    const row = new Setting(container)
      .setName(project.name)
      .setDesc(`📁 ${project.vaultFolder}`);

    row.addText((text) =>
      text
        .setValue(project.name)
        .setPlaceholder('Project name')
        .onChange(async (val) => {
          if (val.trim()) {
            this.plugin.manager.updateProject(project.id, { name: val.trim() });
            await this.plugin.saveSettings();
          }
        }),
    );

    row.addButton((btn) =>
      btn
        .setIcon('trash')
        .setWarning()
        .setTooltip('Delete project (threads are kept)')
        .onClick(async () => {
          this.plugin.manager.deleteProject(project.id);
          await this.plugin.saveSettings();
          refresh();
        }),
    );

    new Setting(container)
      .setName('Project context')
      .setDesc('Injected into Claude\'s system prompt for every message in this project.')
      .setClass('ct-project-context-setting')
      .addTextArea((area) => {
        area
          .setPlaceholder('Goals, conventions, key files — anything Claude should always know…')
          .setValue(project.description ?? '')
          .onChange(async (val) => {
            this.plugin.manager.updateProject(project.id, { description: val });
            await this.plugin.saveSettings();
          });
        area.inputEl.rows = 4;
        area.inputEl.addClass('ct-settings-wide-input');
      });
  }

  // ── Features ────────────────────────────────────────────────────────────

  private renderFeaturesTab(containerEl: HTMLElement): void {
    // — Summarization —
    new Setting(containerEl)
      .setName('Summarization')
      .setDesc('Short summary + suggested title per thread, generated with the Claude CLI. Keeps the agent dashboard readable at a glance.')
      .setHeading();

    new Setting(containerEl)
      .setName('Enable summarization')
      .setDesc('Show a Summarize button in each thread and enable the "Summarize active thread" command.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.summarizationEnabled).onChange(async (value) => {
          this.plugin.settings.summarizationEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.summarizationEnabled) {
      new Setting(containerEl)
        .setName('Auto-summarize after response')
        .setDesc('Regenerate the summary after each assistant turn.')
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.autoSummarize).onChange(async (value) => {
            this.plugin.settings.autoSummarize = value;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Summarization model')
        .setDesc('Model alias passed to claude --model. "haiku" is fast and cheap; "sonnet" is higher quality.')
        .addText((text) =>
          text
            .setPlaceholder('haiku')
            .setValue(this.plugin.settings.inprocessModel)
            .onChange(async (value) => {
              this.plugin.settings.inprocessModel = value || 'haiku';
              await this.plugin.saveSettings();
            }),
        );
    }

    // — Speech to text —
    new Setting(containerEl).setName('Speech to text').setHeading();

    {
      const existingKey = this.app.secretStorage.getSecret('openai-api-key');
      const maskedKey = maskOpenAiKey(existingKey);
      const openAiSetting = new Setting(containerEl)
        .setName('OpenAI API key')
        .setDesc('Used for Whisper speech-to-text. Stored in your OS keychain.');

      openAiSetting.descEl.createEl('br');
      openAiSetting.descEl.createEl('span', {
        text: maskedKey,
        cls: 'ct-openai-key-display',
      });

      openAiSetting
        .addButton((btn) => {
          if (!existingKey) btn.setCta();
          btn.setButtonText(existingKey ? 'Change' : 'Set key').onClick(() => {
            new OpenAiKeyModal(this.app, () => this.display()).open();
          });
        })
        .addButton((btn) => {
          btn.setButtonText('Link existing').setTooltip('Use a key already stored by another plugin').onClick(() => {
            const tmp = document.body.createDiv();
            tmp.style.display = 'none';
            const picker = new SecretComponent(this.app, tmp);
            picker.onChange((secretName: string) => {
              tmp.remove();
              if (!secretName) return;
              const actualValue = this.app.secretStorage.getSecret(secretName);
              if (actualValue) {
                this.app.secretStorage.setSecret('openai-api-key', actualValue);
                new Notice('Key linked');
                this.display();
              } else {
                new Notice('That secret has no value stored');
              }
            });
            // SecretComponent renders a button — click it immediately to open the picker
            const inner = tmp.querySelector('button, input') as HTMLElement | null;
            if (inner) {
              inner.click();
            } else {
              tmp.remove();
              new Notice('Secret picker not available');
            }
          });
        });
    }

    new Setting(containerEl)
      .setName('Push-to-talk hotkey')
      .setDesc('Hold this key while focused in any input to record. Default: Alt+Space (Option+Space on Mac).')
      .addButton((btn) => {
        const updateLabel = () => {
          btn.setButtonText(this.plugin.settings.pttKey || 'Click to set');
        };
        updateLabel();
        btn.onClick(() => {
          btn.setButtonText('Press a key…');
          btn.buttonEl.classList.add('mod-warning');
          const capture = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const key = serializeKey(e);
            if (!key) return; // bare modifier — wait for a real key
            window.removeEventListener('keydown', capture, true);
            btn.buttonEl.classList.remove('mod-warning');
            this.plugin.settings.pttKey = key;
            void this.plugin.saveSettings();
            updateLabel();
          };
          window.addEventListener('keydown', capture, true);
        });
      })
      .addExtraButton((btn) => {
        btn.setIcon('rotate-ccw').setTooltip('Reset to Alt+Space');
        btn.onClick(() => {
          this.plugin.settings.pttKey = 'Alt+Space';
          void this.plugin.saveSettings();
          this.display();
        });
      });

    // — Scheduled tasks —
    new Setting(containerEl)
      .setName('Scheduled tasks')
      .setDesc('Recurring tasks that open a new thread on a schedule. Create one by asking Claude: "set up a daily task at 9am to…"')
      .setHeading();

    const scheduledList = containerEl.createDiv({ cls: 'ct-scheduled-list' });
    const renderScheduledItems = () => {
      scheduledList.empty();
      const items = this.plugin.settings.scheduledItems ?? [];
      if (items.length === 0) {
        scheduledList.createEl('p', { text: 'No scheduled tasks yet. Ask Claude to create one.', cls: 'ct-settings-empty' });
        return;
      }
      for (const item of items) {
        const desc = formatScheduleDescription(item.schedule);
        const lastRunStr = item.lastRun ? `Last run: ${new Date(item.lastRun).toLocaleString()}` : 'Never run';
        const nextRunStr = item.enabled && item.nextRun ? `Next: ${new Date(item.nextRun).toLocaleString()}` : '';
        new Setting(scheduledList)
          .setName(item.name)
          .setDesc(`${desc} - ${lastRunStr}${nextRunStr ? ' - ' + nextRunStr : ''}`)
          .addToggle((toggle) =>
            toggle.setValue(item.enabled).onChange(async (val) => {
              this.plugin.scheduler.updateItem(item.id, { enabled: val });
              renderScheduledItems();
            }),
          )
          .addButton((btn) =>
            btn.setIcon('trash').setWarning().setTooltip('Delete').onClick(async () => {
              this.plugin.scheduler.deleteItem(item.id);
              renderScheduledItems();
            }),
          );
      }
    };
    renderScheduledItems();
  }

  // ── Remote ──────────────────────────────────────────────────────────────

  private renderRemoteTab(containerEl: HTMLElement): void {
    const ra = this.plugin.settings.remoteAccess;

    new Setting(containerEl)
      .setName('Enable remote access')
      .setDesc('Let Obsidian Mobile connect to this desktop via a relay server and control sessions in real time.')
      .addToggle((toggle) =>
        toggle.setValue(ra.enabled).onChange(async (value) => {
          ra.enabled = value;
          if (value && !ra.roomId) {
            ra.roomId = generateRoomId();
          }
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.initDesktopRelayClient();
          } else {
            this.plugin.relayClient?.disconnect();
            this.plugin.relayClient = null;
          }
          this.display(); // Refresh to show/hide controls
        }),
      );

    if (ra.enabled && ra.roomId) {
      const maskedId = '••••••••-••••••••-••••••••-' + ra.roomId.slice(-8).toUpperCase();

      new Setting(containerEl)
        .setName('Room ID')
        .setDesc(`Your device pairing identifier. ${maskedId}`)
        .addButton((btn) =>
          btn
            .setButtonText('Show pairing QR code')
            .setCta()
            .onClick(() => {
              new PairingModal(this.app, this.plugin).open();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText('Rotate room ID')
            .setWarning()
            .onClick(async () => {
              ra.roomId = generateRoomId();
              ra.pairingCode = null;
              ra.pairingExpiresAt = null;
              await this.plugin.saveSettings();
              this.plugin.relayClient?.disconnect();
              this.plugin.relayClient = null;
              if (ra.enabled) {
                this.plugin.initDesktopRelayClient();
              }
              this.display();
            }),
        );

      const isConnected = this.plugin.relayClient?.isConnected() ?? false;
      new Setting(containerEl)
        .setName('Connection status')
        .setDesc(isConnected ? 'Mobile relay connected' : 'Mobile relay not connected');

      new Setting(containerEl)
        .setName('Relay URL')
        .setDesc('WebSocket relay server URL. Change only if self-hosting.')
        .addText((text) =>
          text
            .setPlaceholder('wss://relay.claude-threads.rbcodelabs.com')
            .setValue(ra.relayUrl)
            .onChange(async (value) => {
              ra.relayUrl = value || 'wss://relay.claude-threads.rbcodelabs.com';
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  // ── Mobile ──────────────────────────────────────────────────────────────

  /** Minimal settings shown on mobile (desktop-only settings are omitted). */
  private renderMobileOnlySettings(containerEl: HTMLElement): void {
    const ra = this.plugin.settings.remoteAccess;
    const isConnected = this.plugin.relayClient?.isConnected() ?? false;

    // Connection status banner
    const statusEl = containerEl.createDiv({ cls: 'ct-mobile-status' });
    statusEl.createEl('p', {
      text: isConnected ? 'Connected to desktop.' : 'Not connected to desktop.',
      cls: isConnected ? 'ct-mobile-status-ok' : 'ct-mobile-status-disconnected',
    });

    new Setting(containerEl).setName('Pair with desktop').setHeading();
    containerEl.createEl('p', {
      text: 'On your desktop, open Settings > Claude Threads > Remote, enable remote access, then tap "Show pairing QR code". Scan that QR code with your phone camera — your phone will ask to open Obsidian, which will connect automatically.',
      cls: 'ct-settings-desc',
    });

    let manualRoomId = '';
    new Setting(containerEl)
      .setName('Pairing code')
      .setDesc('If the QR scan does not work, paste the code shown on desktop.')
      .addText((text) => {
        text
          .setPlaceholder('XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX')
          .setValue(ra.roomId ? formatRoomIdAsCode(ra.roomId) : '')
          .onChange((val) => { manualRoomId = val.trim(); });
        return text;
      })
      .addButton((btn) =>
        btn.setButtonText('Connect').setCta().onClick(async () => {
          // Accept both the formatted code (XXXX-XXXX-...) and raw hex
          const raw = manualRoomId.replace(/-/g, '').toLowerCase();
          if (!/^[0-9a-f]{32}$/.test(raw)) {
            new Notice('Invalid pairing code. Copy the code exactly from desktop Settings.');
            return;
          }
          ra.roomId = raw;
          ra.enabled = true;
          await this.plugin.saveSettings();
          this.plugin.initMobileRelayClient();
          new Notice('Connecting to desktop…');
          this.display(); // Refresh status
        }),
      );

    // Show current room ID if paired
    if (ra.roomId) {
      const maskedId = '••••••••-••••••••-••••••••-' + ra.roomId.slice(-8).toUpperCase();
      new Setting(containerEl)
        .setName('Paired room')
        .setDesc(maskedId)
        .addButton((btn) =>
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            this.plugin.relayClient?.disconnect();
            this.plugin.relayClient = null;
            ra.roomId = '';
            ra.enabled = false;
            await this.plugin.saveSettings();
            this.display();
          }),
        );
    }

    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('Relay URL')
      .setDesc('WebSocket relay server. Change only if self-hosting.')
      .addText((text) =>
        text
          .setPlaceholder('wss://claude-threads-relay.rbcodelabs.workers.dev')
          .setValue(ra.relayUrl)
          .onChange(async (value) => {
            ra.relayUrl = value || 'wss://claude-threads-relay.rbcodelabs.workers.dev';
            await this.plugin.saveSettings();
          }),
      );
  }
}
