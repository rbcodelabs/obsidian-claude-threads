import * as fs from 'fs/promises';
import * as path from 'path';
import type { DesignArtifact, Thread } from './types';

export const DESIGN_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface DesignArtifactManifest {
  schemaVersion: typeof DESIGN_ARTIFACT_SCHEMA_VERSION;
  id: string;
  title: string;
  entry: 'index.html';
  runtime: 'static';
  createdByThreadId: string;
  viewport: { preset: 'desktop'; width: 1440; height: 900 };
  permissions: { network: 'none'; clipboard: false };
}

export interface DesignArtifactFs {
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  writeFile(target: string, data: string, options?: { flag: 'wx' }): Promise<unknown>;
}

export interface DesignThreadDispatchDeps {
  createThread(title: string, agentHarness?: 'claude' | 'codex'): Thread;
  deleteThread(threadId: string): void;
  saveSettings(): Promise<void>;
  sendMessage(threadId: string, message: string): Promise<void>;
  openThread(threadId: string): Promise<void>;
  openPreview(artifact: DesignArtifact): Promise<void>;
  onSendError(error: unknown): void;
}

const defaultFs: DesignArtifactFs = {
  mkdir: (target, options) => fs.mkdir(target, options),
  writeFile: (target, data, options) => fs.writeFile(target, data, options),
};

export function artifactIdForThread(threadId: string): string {
  const safe = threadId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `design-${safe.slice(0, 48) || 'thread'}`;
}

export function designTitle(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').trim();
  if (!firstLine) return 'Design artifact';
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}…`;
}

export function designArtifactRoot(vaultRoot: string, threadId: string): string {
  return path.join(vaultRoot, '.geode', 'artifacts', artifactIdForThread(threadId));
}

export function buildDesignManifest(threadId: string, brief: string): DesignArtifactManifest {
  return {
    schemaVersion: DESIGN_ARTIFACT_SCHEMA_VERSION,
    id: artifactIdForThread(threadId),
    title: designTitle(brief),
    entry: 'index.html',
    runtime: 'static',
    createdByThreadId: threadId,
    viewport: { preset: 'desktop', width: 1440, height: 900 },
    permissions: { network: 'none', clipboard: false },
  };
}

function scaffoldHtml(title: string): string {
  const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escaped}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="design-shell">
    <p class="eyebrow">Claude Threads · Design</p>
    <h1>${escaped}</h1>
    <p>The design agent is preparing this artifact.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
}

const SCAFFOLD_CSS = `:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #0f1115;
  color: #f5f7fb;
}
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at top, #25304a, #0f1115 55%); }
.design-shell { width: min(680px, calc(100% - 48px)); padding: 48px; border: 1px solid #ffffff24; border-radius: 24px; background: #171a22e6; box-shadow: 0 24px 80px #0008; }
.eyebrow { color: #9eb7ff; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
h1 { margin: 12px 0; font-size: clamp(36px, 6vw, 72px); line-height: .98; }
p { color: #bdc5d6; line-height: 1.6; }
`;

const SCAFFOLD_JS = `document.documentElement.dataset.artifactReady = 'true';\n`;

async function writeIfMissing(fileFs: DesignArtifactFs, target: string, content: string): Promise<void> {
  try {
    await fileFs.writeFile(target, content, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export async function ensureDesignArtifact(
  thread: Pick<Thread, 'id' | 'artifacts'>,
  vaultRoot: string,
  brief: string,
  now = Date.now(),
  fileFs: DesignArtifactFs = defaultFs,
): Promise<DesignArtifact> {
  const existing = thread.artifacts?.find((artifact) => artifact.kind === 'design-static');
  if (existing) {
    existing.updatedAt = now;
    return existing;
  }

  const root = designArtifactRoot(vaultRoot, thread.id);
  const manifest = buildDesignManifest(thread.id, brief);
  await fileFs.mkdir(root, { recursive: true });
  await writeIfMissing(fileFs, path.join(root, 'artifact.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeIfMissing(fileFs, path.join(root, 'index.html'), scaffoldHtml(manifest.title));
  await writeIfMissing(fileFs, path.join(root, 'styles.css'), SCAFFOLD_CSS);
  await writeIfMissing(fileFs, path.join(root, 'app.js'), SCAFFOLD_JS);

  const artifact: DesignArtifact = {
    id: manifest.id,
    kind: 'design-static',
    title: manifest.title,
    root,
    manifestPath: path.join(root, 'artifact.json'),
    entryPath: path.join(root, manifest.entry),
    createdAt: now,
    updatedAt: now,
  };
  if (!thread.artifacts) thread.artifacts = [];
  thread.artifacts.push(artifact);
  return artifact;
}

export function designKickoffMessage(artifact: DesignArtifact, brief: string): string {
  return `You are working in Claude Threads Design mode.

Create or revise the static UI artifact at:
${artifact.root}

User brief:
${brief.trim()}

Artifact rules:
- Treat artifact.json as the host contract; do not change its schemaVersion, id, runtime, thread id, or permissions.
- Build a polished responsive interface using index.html, styles.css, app.js, and local assets only.
- Use external CSS and JavaScript files. Inline JavaScript is blocked by the artifact CSP.
- Do not install packages, start a server, load remote fonts, call network APIs, submit forms, or request clipboard access.
- Keep every asset beneath the artifact root and use relative paths.
- Preserve accessibility: semantic landmarks, keyboard operation, labels, focus states, and sufficient contrast.
- Review desktop and mobile layouts before finishing.

Start now. Edit the artifact files directly, verify the static result, and report what you changed.`;
}

/**
 * Creates a new thread around the same durable artifact contract used by the
 * in-thread /design command. The artifact is persisted before the agent turn
 * starts so a fast first tool call cannot race the thread metadata save.
 */
export async function dispatchDesignThread(
  brief: string,
  agentHarness: 'claude' | 'codex' | undefined,
  vaultRoot: string,
  deps: DesignThreadDispatchDeps,
  fileFs: DesignArtifactFs = defaultFs,
): Promise<string> {
  const thread = deps.createThread(designTitle(brief), agentHarness);
  let artifact: DesignArtifact;
  try {
    artifact = await ensureDesignArtifact(thread, vaultRoot, brief, Date.now(), fileFs);
    await deps.saveSettings();
  } catch (error) {
    deps.deleteThread(thread.id);
    throw error;
  }

  void deps.sendMessage(thread.id, designKickoffMessage(artifact, brief)).catch(deps.onSendError);
  await deps.openThread(thread.id);
  await deps.openPreview(artifact);
  return thread.id;
}
