/**
 * Speech-to-text support via OpenAI Whisper.
 *
 * SttController manages a single MediaRecorder session and provides:
 *  - createMicButton(): factory for click-to-toggle mic buttons
 *  - attachPttToTextarea(): hold-to-record keyboard shortcut for an input
 *
 * Multiple buttons (dispatch + chat input) share the same controller so
 * pressing any one stops an already-running recording from another input.
 */

import { Notice } from 'obsidian';
import type { App, SecretStorage } from 'obsidian';

type MicButtonState = 'idle' | 'recording' | 'processing';

interface MicButtonEntry {
  btn: HTMLButtonElement;
  targetInput: HTMLTextAreaElement;
  setState: (s: MicButtonState) => void;
}

export class SttController {
  private app: App;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private activeEntry: MicButtonEntry | null = null;
  private entries: MicButtonEntry[] = [];
  /** True while a PTT keydown is active — prevents click-toggle confusion. */
  private pttActive = false;
  private pttCleanupFns: Array<() => void> = [];

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Create a mic button and bind it to targetInput.
   * The returned button should be inserted into the DOM by the caller.
   */
  createMicButton(targetInput: HTMLTextAreaElement): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'ct-mic-btn';
    btn.setAttribute('title', 'Voice input (click to record)');
    btn.setAttribute('aria-label', 'Toggle voice recording');
    btn.setAttribute('type', 'button');
    btn.innerHTML = micSvg();

    const entry: MicButtonEntry = {
      btn,
      targetInput,
      setState: (s: MicButtonState) => applyState(btn, s),
    };
    this.entries.push(entry);

    btn.addEventListener('click', () => {
      void this.handleClick(entry);
    });

    return btn;
  }

  /**
   * Attach push-to-talk behaviour to a textarea.
   *
   * getKey() is called on every event so changes to the hotkey take effect
   * immediately without re-attaching. keydown starts recording; keyup on
   * document stops it (handles focus loss between press and release).
   *
   * Returns a cleanup function. Also stored internally so destroy() covers it.
   */
  attachPttToTextarea(textarea: HTMLTextAreaElement, getKey: () => string): () => void {
    const entry = this.entries.find(e => e.targetInput === textarea);
    if (!entry) return () => {};

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = getKey();
      if (!key || !matchesKey(e, key)) return;
      if (this.recorder && this.recorder.state === 'recording') return;
      e.preventDefault();
      this.pttActive = true;
      void this.beginRecording(entry);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = getKey();
      if (!key || !matchesKey(e, key)) return;
      if (!this.pttActive) return;
      this.pttActive = false;
      if (this.recorder && this.recorder.state === 'recording') {
        this.recorder.stop();
      }
    };

    textarea.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    const cleanup = () => {
      textarea.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    };
    this.pttCleanupFns.push(cleanup);
    return cleanup;
  }

  /** Stop any active recording and release resources (call on view close). */
  destroy(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.activeEntry = null;
    this.entries = [];
    for (const fn of this.pttCleanupFns) fn();
    this.pttCleanupFns = [];
  }

  private async handleClick(entry: MicButtonEntry): Promise<void> {
    // If another entry is recording, cancel it (no transcription)
    if (this.activeEntry && this.activeEntry !== entry) {
      this.stopRecording(false);
    }

    if (this.recorder && this.recorder.state === 'recording') {
      // Toggle off: stop and transcribe
      this.recorder.stop();
      return;
    }

    void this.beginRecording(entry);
  }

  private async beginRecording(entry: MicButtonEntry): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      new Notice('No OpenAI API key set — add one in Settings > Claude Threads > Speech to Text');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      new Notice(`Microphone access denied: ${(err as Error).message}`);
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : 'audio/ogg';

    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType });
    this.activeEntry = entry;

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.recorder.onstop = async () => {
      // Stop all tracks so the OS mic indicator disappears immediately
      stream.getTracks().forEach(t => t.stop());

      if (!this.activeEntry) return;
      const target = this.activeEntry;

      if (this.chunks.length === 0) {
        target.setState('idle');
        this.activeEntry = null;
        return;
      }

      target.setState('processing');
      for (const e of this.entries) {
        if (e !== target) e.setState('idle');
      }

      const blob = new Blob(this.chunks, { type: mimeType });
      this.chunks = [];

      try {
        const key = this.getApiKey();
        if (!key) {
          new Notice('No OpenAI API key set — add one in Settings > Claude Threads > Speech to Text');
          target.setState('idle');
          this.activeEntry = null;
          return;
        }
        const text = await transcribeAudio(blob, key);
        if (text) {
          insertAtCursor(target.targetInput, text);
        }
      } catch (err) {
        new Notice(`Whisper error: ${(err as Error).message}`);
      } finally {
        target.setState('idle');
        this.activeEntry = null;
        this.recorder = null;
      }
    };

    this.recorder.start();
    entry.setState('recording');
  }

  private stopRecording(transcribe: boolean): void {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    if (!transcribe) {
      this.recorder.onstop = () => {
        if (this.activeEntry) {
          this.activeEntry.setState('idle');
          this.activeEntry = null;
        }
        this.recorder = null;
        this.chunks = [];
      };
    }
    this.recorder.stop();
  }

  private getApiKey(): string | null {
    return (this.app.secretStorage as SecretStorage | undefined)?.getSecret('openai-api-key') ?? null;
  }
}

// ── Key serialization helpers ────────────────────────────────────────────────

/**
 * Convert a KeyboardEvent into a canonical hotkey string, e.g. "Alt+Space".
 * Returns empty string for bare modifier presses — not a valid hotkey.
 */
export function serializeKey(e: KeyboardEvent): string {
  const modifiers = ['Control', 'Shift', 'Alt', 'Meta'];
  if (modifiers.includes(e.key)) return '';
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.key === ' ' ? 'Space' : e.key);
  return parts.join('+');
}

/**
 * Return true if a KeyboardEvent matches a stored hotkey string.
 */
export function matchesKey(e: KeyboardEvent, keyStr: string): boolean {
  if (!keyStr) return false;
  const parts = keyStr.split('+');
  const rawKey = parts[parts.length - 1];
  const modifiers = ['Control', 'Shift', 'Alt', 'Meta'];
  if (modifiers.includes(rawKey)) return false; // malformed — no terminal key
  const expectedKey = rawKey === 'Space' ? ' ' : rawKey;
  return (
    e.key === expectedKey &&
    e.ctrlKey === parts.includes('Control') &&
    e.shiftKey === parts.includes('Shift') &&
    e.altKey === parts.includes('Alt') &&
    e.metaKey === parts.includes('Meta')
  );
}

// ── Audio / DOM helpers ──────────────────────────────────────────────────────

async function transcribeAudio(blob: Blob, apiKey: string): Promise<string> {
  const ext = blob.type.includes('ogg') ? 'recording.ogg' : 'recording.webm';
  const formData = new FormData();
  formData.append('file', blob, ext);
  formData.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Whisper API error: ${res.status}`);
  }

  const json = await res.json() as { text?: string };
  return json.text ?? '';
}

function insertAtCursor(el: HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const separator = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
  el.value = before + separator + text + after;
  const cursor = start + separator.length + text.length;
  el.selectionStart = cursor;
  el.selectionEnd = cursor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

function applyState(btn: HTMLButtonElement, state: MicButtonState): void {
  btn.classList.remove('stt-recording', 'stt-processing');
  btn.disabled = false;
  switch (state) {
    case 'recording':
      btn.classList.add('stt-recording');
      btn.setAttribute('title', 'Recording… release PTT key or click to stop');
      btn.innerHTML = micSvg();
      break;
    case 'processing':
      btn.disabled = true;
      btn.classList.add('stt-processing');
      btn.setAttribute('title', 'Transcribing…');
      btn.innerHTML = spinnerSvg();
      break;
    case 'idle':
    default:
      btn.setAttribute('title', 'Voice input (click to record)');
      btn.innerHTML = micSvg();
      break;
  }
}

function micSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
    <line x1="8" y1="22" x2="16" y2="22"/>
  </svg>`;
}

function spinnerSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    class="ct-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>`;
}
