import type { ChatMessage } from './types';

type ProgressCallback = (status: string) => void;

export class InProcessSummarizer {
  private pipe: ((text: string, opts: object) => Promise<Array<{ summary_text: string }>>) | null = null;
  private loading = false;
  private loadPromise: Promise<void> | null = null;

  // wasmBaseUrl must point to the directory containing the .wasm files (the plugin dist/).
  async initialize(wasmBaseUrl: string, model: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.pipe) return;
    if (this.loading) { await this.loadPromise; return; }

    this.loading = true;
    this.loadPromise = (async () => {
      const { env, pipeline } = await import('@xenova/transformers');

      // Point the WASM runtime at our bundled .wasm files so it doesn't
      // need to fetch them from a CDN.
      env.backends.onnx.wasm.wasmPaths = wasmBaseUrl;

      onProgress?.(`Downloading model "${model}" — first-time only, may take a minute…`);

      this.pipe = await pipeline('summarization', model, {
        progress_callback: (info: { status: string; file?: string; progress?: number }) => {
          if (info.status === 'downloading' || info.status === 'progress') {
            const pct = info.progress != null ? ` ${Math.round(info.progress)}%` : '';
            onProgress?.(`Downloading${pct}: ${info.file ?? model}`);
          } else if (info.status === 'done') {
            onProgress?.('Model ready');
          }
        },
      }) as typeof this.pipe;
    })();

    try {
      await this.loadPromise;
    } finally {
      this.loading = false;
    }
  }

  async summarize(
    messages: ChatMessage[],
    wasmBaseUrl: string,
    model: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    await this.initialize(wasmBaseUrl, model, onProgress);

    const text = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 600)}`)
      .join('\n\n')
      .slice(0, 3000);

    const result = await this.pipe!(text, {
      max_length: 120,
      min_length: 20,
      no_repeat_ngram_size: 3,
    });

    return result[0].summary_text.trim();
  }
}
