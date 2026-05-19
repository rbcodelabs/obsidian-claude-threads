import { App, TFile } from 'obsidian';
import type { Thread, ChatMessage, ThreadStatus } from './types';

export class VaultPersistence {
  constructor(
    private app: App,
    private folder: string,
  ) {}

  async saveThread(thread: Thread): Promise<string> {
    await this.ensureFolder();
    const slug = thread.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    const date = new Date(thread.createdAt).toISOString().split('T')[0];
    const fileName = `${this.folder}/${date}-${slug}.md`;
    const content = this.threadToMarkdown(thread);

    const existing = this.app.vault.getAbstractFileByPath(fileName);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(fileName, content);
    }
    // Keep noteFile in sync so callers can reference the vault path.
    thread.noteFile = fileName;
    return fileName;
  }

  /**
   * Scans the vault folder and sets `status: archived` on any thread note
   * whose thread_id is NOT in `activeThreadIds` and currently has `status: waiting`.
   * Call this at startup to clean up stale notes from before the archive-on-close
   * feature was introduced.
   */
  async archiveOrphanedNotes(activeThreadIds: Set<string>): Promise<number> {
    let count = 0;
    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(this.folder + '/'),
    );

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        const idMatch = fm.match(/^thread_id:\s*(.+)$/m);
        const statusMatch = fm.match(/^status:\s*(.+)$/m);
        if (!idMatch || !statusMatch) continue;

        const threadId = idMatch[1].trim();
        const status = statusMatch[1].trim();
        if (status !== 'waiting') continue;
        if (activeThreadIds.has(threadId)) continue;

        // Replace status in the frontmatter only
        const updated = content.replace(/^(status:\s*)waiting$/m, '$1archived');
        await this.app.vault.modify(file, updated);
        count++;
      } catch {
        // skip unreadable files
      }
    }
    return count;
  }

  async loadAllThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(this.folder + '/'),
    );

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const thread = this.markdownToThread(content, file.path);
        if (thread) threads.push(thread);
      } catch {
        // skip malformed files
      }
    }
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async ensureFolder(): Promise<void> {
    const exists = this.app.vault.getAbstractFileByPath(this.folder);
    if (!exists) {
      await this.app.vault.createFolder(this.folder);
    }
  }

  private threadToMarkdown(thread: Thread): string {
    const status = thread.status ?? 'waiting';
    const messageCount = thread.messages.filter((m) => m.role !== 'compact').length;
    const headerParts = [
      '---',
      `thread_id: ${thread.id}`,
      thread.sessionId ? `claude_session_id: ${thread.sessionId}` : null,
      `title: "${thread.title.replace(/"/g, '\\"')}"`,
      `status: ${status}`,
      `cwd: ${thread.cwd}`,
      thread.model ? `model: ${thread.model}` : null,
      `message_count: ${messageCount}`,
      thread.summary ? `summary: "${thread.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"` : null,
      `created: ${new Date(thread.createdAt).toISOString()}`,
      `updated: ${new Date(thread.updatedAt).toISOString()}`,
      '---',
      '',
      `# ${thread.title}`,
      '',
    ];
    const header = headerParts.filter((l): l is string => l !== null).join('\n');

    const messages = thread.messages
      .map((m) => this.messageToMarkdown(m))
      .join('\n\n');

    return header + messages + '\n';
  }

  private messageToMarkdown(msg: ChatMessage): string {
    if (msg.role === 'compact') return '';
    const prefix = msg.role === 'user' ? '**You:**' : '**Claude:**';
    let body = `${prefix}\n\n${msg.content}`;
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const tools = msg.toolCalls.map((t) => `  - \`${t.summary}\``).join('\n');
      body = `> [!info] Tools used\n${tools}\n\n${body}`;
    }
    return body;
  }

  private markdownToThread(content: string, filePath: string): Thread | null {
    try {
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      const fm = frontmatterMatch[1];
      const get = (key: string) => {
        const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return m ? m[1].trim() : undefined;
      };

      const id = get('thread_id');
      const cwd = get('cwd');
      if (!id || !cwd) return null;

      const titleMatch = content.match(/^# (.+)$/m);
      const title = titleMatch ? titleMatch[1] : (get('title')?.replace(/^"|"$/g, '') ?? 'Untitled');
      const sessionId = get('claude_session_id');
      const createdAt = get('created') ? new Date(get('created')!).getTime() : Date.now();
      const updatedAt = get('updated') ? new Date(get('updated')!).getTime() : createdAt;
      const rawStatus = get('status');
      const status = (rawStatus === 'waiting' || rawStatus === 'active' || rawStatus === 'error' || rawStatus === 'archived')
        ? rawStatus as ThreadStatus
        : 'waiting';
      const model = get('model');
      const summaryRaw = get('summary');
      const summary = summaryRaw ? summaryRaw.replace(/^"|"$/g, '') : undefined;

      const messages = this.parseMessages(content.replace(/^---[\s\S]*?---\n/, ''));

      return {
        id,
        sessionId,
        title,
        cwd,
        messages,
        createdAt,
        updatedAt,
        noteFile: filePath,
        status,
        model,
        summary,
      };
    } catch {
      return null;
    }
  }

  private parseMessages(body: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const parts = body.split(/\n\n(?=\*\*(?:You|Claude):\*\*)/);
    let timestamp = Date.now();

    for (const part of parts) {
      const userMatch = part.match(/^\*\*You:\*\*\n\n([\s\S]*?)$/);
      const claudeMatch = part.match(/^\*\*Claude:\*\*\n\n([\s\S]*?)$/);

      if (userMatch) {
        messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          content: userMatch[1].trim(),
          timestamp: timestamp++,
        });
      } else if (claudeMatch) {
        messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: claudeMatch[1].trim(),
          timestamp: timestamp++,
        });
      }
    }

    return messages;
  }
}
