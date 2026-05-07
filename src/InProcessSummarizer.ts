import type { ChatMessage } from './types';
import type { MLCEngine, InitProgressReport } from '@mlc-ai/web-llm';

type ProgressCallback = (status: string) => void;

export class InProcessSummarizer {
  private engine: MLCEngine | null = null;
  private loadedModel: string | null = null;
  private loadPromise: Promise<void> | null = null;

  async initialize(modelId: string, onProgress?: ProgressCallback): Promise<void> {
    if (this.engine && this.loadedModel === modelId) return;
    if (this.loadPromise) { await this.loadPromise; return; }

    this.loadPromise = (async () => {
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
      onProgress?.(`Loading ${modelId} — downloading on first use, then cached…`);

      this.engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (report: InitProgressReport) => {
          const pct = report.progress > 0 ? ` ${Math.round(report.progress * 100)}%` : '';
          onProgress?.(`${report.text}${pct}`);
        },
      });
      this.loadedModel = modelId;
      onProgress?.('Model ready');
    })();

    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async summarize(
    messages: ChatMessage[],
    modelId: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    await this.initialize(modelId, onProgress);

    const transcript = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 600)}`)
      .join('\n\n')
      .slice(0, 3000);

    const response = await this.engine!.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            'You are a concise summarizer. Respond with 2-3 sentences covering what is being worked on, key decisions made, and current status. Be specific about files, projects, or tasks mentioned.',
        },
        { role: 'user', content: `Summarize this conversation:\n\n${transcript}` },
      ],
      max_tokens: 150,
      temperature: 0.3,
    });

    return response.choices[0].message.content?.trim() ?? '';
  }

  unload(): void {
    this.engine?.unload();
    this.engine = null;
    this.loadedModel = null;
  }
}
