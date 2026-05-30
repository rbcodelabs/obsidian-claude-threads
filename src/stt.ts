/**
 * Speech-to-text support via OpenAI Whisper.
 *
 * SttController manages a single MediaRecorder session and provides a
 * createMicButton() factory that wires a <button> to that session.
 * Multiple buttons (dispatch + chat input) can share the same controller —
 * pressing any one of them will stop an already-running recording from any
 * other input, insert the transcript there, and leave all buttons in sync.
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';

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

  /** Stop any active recording and release resources (call on view close). */
  destroy(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.activeEntry = null;
    this.entries = [];
  }

  private async handleClick(entry: MicButtonEntry): Promise<void> {
    // If another entry is recording, stop it (no transcription) and reset
    if (this.activeEntry && this.activeEntry !== entry) {
      this.stopRecording(false);
    }

    if (this.recorder && this.recorder.state === 'recording') {
      // Toggle off: stop and transcribe
      this.recorder.stop();
      return;
    }

    // Verify API key before touching the mic
    const apiKey = this.getApiKey();
    if (!apiKey) {
      new Notice('No OpenAI API key set — add one in Settings > Claude Threads > Speech to Text');
      return;
    }

    // Start recording
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
      // Stop all tracks so the OS mic indicator goes away
      stream.getTracks().forEach(t => t.stop());

      if (!this.activeEntry) return;
      const target = this.activeEntry;

      if (this.chunks.length === 0) {
        target.setState('idle');
        this.activeEntry = null;
        return;
      }

      target.setState('processing');
      // Set all other buttons to idle while we wait
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
      // Swap onstop so it doesn't transcribe
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
    // app.secretStorage is available since Obsidian 1.11.4 — synchronous API
    const storage = (this.app as unknown as { secretStorage?: { getSecret: (id: string) => string | null } }).secretStorage;
    if (!storage) return null;
    return storage.getSecret('openai-api-key');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  // Add a space separator if inserting into non-empty content
  const separator = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
  el.value = before + separator + text + after;
  const cursor = start + separator.length + text.length;
  el.selectionStart = cursor;
  el.selectionEnd = cursor;
  // Fire input event so any listeners (draft save, autocomplete) know the value changed
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

function applyState(btn: HTMLButtonElement, state: MicButtonState): void {
  btn.classList.remove('stt-recording', 'stt-processing');
  btn.disabled = false;
  switch (state) {
    case 'recording':
      btn.classList.add('stt-recording');
      btn.setAttribute('title', 'Recording… click to stop');
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
  // Simple microphone icon (Lucide-style)
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
