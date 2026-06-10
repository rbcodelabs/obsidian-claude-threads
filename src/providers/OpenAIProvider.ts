/**
 * OpenAIProvider — drives the OpenAI API (Responses API for Codex models,
 * Chat Completions for everything else).
 *
 * Capability gaps vs Anthropic:
 *   - No session resumption: full conversationHistory is sent on every call.
 *   - No tool permission gating: OpenAI tool calls execute without user approval.
 *   - No MCP servers: Obsidian tools are unavailable; appendSystemPrompt still works.
 *   - Code execution: enabled for codex-* models when openAICodeExecution is true.
 *
 * Error handling:
 *   - 401/403  → onError with "Check your OpenAI API key in plugin settings."
 *   - 429      → exponential backoff, up to MAX_RETRIES, fires onApiRetry each attempt.
 *   - Stream abort / network error → commits partial response then calls onError.
 *   - Missing openai package → onError with installation guidance.
 *
 * The openai npm package is lazy-required so it only loads when the user has
 * configured OpenAI as their active provider.
 */

import type { AIProvider, ProviderCapabilities, RunOptions } from './AIProvider';
import type { ChatMessage } from '../types';
import { debugLog } from '../logger';

// ── Capability declaration ────────────────────────────────────────────────────

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  sessionResumption: false,
  toolPermissionGating: false,
  mcpServers: false,
  visionInput: true,
  codeExecution: true,
  opusEscalation: false,
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

// Models that use the Responses API (Codex / o-series reasoning models).
// Everything else falls back to Chat Completions.
const RESPONSES_API_MODEL_PREFIXES = ['codex-', 'o1', 'o3', 'o4'];

function usesResponsesApi(model: string): boolean {
  const lower = model.toLowerCase();
  return RESPONSES_API_MODEL_PREFIXES.some(p => lower.startsWith(p));
}

// ── Helper: convert ChatMessage[] → OpenAI message format ─────────────────────

interface OAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | OAIContentPart[];
}

interface OAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

function toOpenAIMessages(
  history: ChatMessage[],
  currentPrompt: string,
  appendSystemPrompt?: string,
): OAIMessage[] {
  const messages: OAIMessage[] = [];

  if (appendSystemPrompt) {
    messages.push({ role: 'system', content: appendSystemPrompt });
  }

  for (const msg of history) {
    if (msg.role === 'compact') continue; // skip compaction markers
    const role = msg.role === 'user' ? 'user' : 'assistant';

    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const parts: OAIContentPart[] = [];
      if (msg.content.trim()) parts.push({ type: 'text', text: msg.content });
      for (const img of msg.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
      }
      messages.push({ role, content: parts });
    } else {
      messages.push({ role, content: msg.content });
    }
  }

  // Append the current prompt as the final user message
  messages.push({ role: 'user', content: currentPrompt });

  return messages;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class OpenAIProvider implements AIProvider {
  readonly capabilities: ProviderCapabilities = OPENAI_CAPABILITIES;

  private abortController: AbortController | null = null;
  private interrupted = false;

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string = 'gpt-4o',
    private readonly enableCodeExecution: boolean = false,
  ) {}

  async run(opts: RunOptions): Promise<void> {
    const {
      prompt,
      callbacks,
      model: modelOverride,
      images,
      appendSystemPrompt,
      conversationHistory = [],
    } = opts;

    this.interrupted = false;

    if (!this.apiKey) {
      callbacks.onError(new Error('OpenAI API key is not configured. Add it in Claude Threads plugin settings.'));
      return;
    }

    // Lazy-require to avoid loading at module init time (bundle safety for mobile).
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    let OpenAI: new (opts: { apiKey: string }) => any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      OpenAI = require('openai').default ?? require('openai');
    } catch {
      callbacks.onError(new Error(
        'The openai npm package is not installed. ' +
        'Run: npm install openai in the plugin directory.',
      ));
      return;
    }

    const model = modelOverride ?? this.defaultModel;
    const client = new OpenAI({ apiKey: this.apiKey });

    callbacks.onStatus?.('requesting');

    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        if (usesResponsesApi(model)) {
          await this.runResponsesApi(client, model, prompt, conversationHistory, images, appendSystemPrompt, callbacks);
        } else {
          await this.runChatCompletions(client, model, prompt, conversationHistory, images, appendSystemPrompt, callbacks);
        }
        return; // success
      } catch (err: unknown) {
        if (this.interrupted) {
          callbacks.onInterrupted('');
          return;
        }

        const status = (err as { status?: number }).status;

        if (status === 401 || status === 403) {
          callbacks.onError(new Error(
            `OpenAI authentication failed (${status}). Check your API key in Claude Threads plugin settings.`,
          ));
          return;
        }

        if (status === 429 && attempt < MAX_RETRIES) {
          attempt++;
          const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          const errMsg = err instanceof Error ? err.message : String(err);
          callbacks.onApiRetry?.(attempt, MAX_RETRIES, errMsg);
          debugLog(`[OpenAIProvider] rate-limited, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }

        // Any other error (5xx, network, stream abort): surface it.
        const e = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(e);
        return;
      }
    }
  }

  // ── Responses API (Codex + o-series) ──────────────────────────────────────

  private async runResponsesApi(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    model: string,
    prompt: string,
    history: ChatMessage[],
    images: RunOptions['images'],
    appendSystemPrompt: string | undefined,
    callbacks: RunOptions['callbacks'],
  ): Promise<void> {
    // Build input: system prompt instruction (if any) + history preamble + current prompt.
    const inputParts: string[] = [];
    if (appendSystemPrompt) inputParts.push(appendSystemPrompt);

    // Flatten prior messages as simple text — Responses API input can be a string or array.
    for (const msg of history) {
      if (msg.role === 'compact') continue;
      const label = msg.role === 'user' ? 'User' : 'Assistant';
      inputParts.push(`${label}: ${msg.content}`);
    }
    inputParts.push(`User: ${prompt}`);

    const input = inputParts.join('\n\n');

    const createOpts: Record<string, unknown> = { model, input, stream: true };
    if (this.enableCodeExecution) {
      createOpts.tools = [{ type: 'code_interpreter', container: { type: 'auto' } }];
    }

    this.abortController = new AbortController();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await (client as any).responses.create(createOpts, {
      signal: this.abortController.signal,
    });

    let accumulatedText = '';
    let responseId = '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of stream as AsyncIterable<any>) {
      if (this.interrupted) break;

      const type: string = event.type ?? '';

      if (type === 'response.output_text.delta') {
        const delta: string = event.delta ?? '';
        if (delta) {
          accumulatedText += delta;
          callbacks.onToken(delta);
        }
      } else if (type === 'response.output_text.done') {
        // Text block complete — flush as a message.
        if (accumulatedText) {
          callbacks.onMessage(accumulatedText, []);
          accumulatedText = '';
        }
      } else if (type === 'response.completed') {
        responseId = event.response?.id ?? '';
        callbacks.onStatus?.(null);
        callbacks.onDone(responseId, 0, 1);
        return;
      } else if (type === 'error') {
        const errMsg: string = event.message ?? 'Unknown Responses API error';
        throw new Error(errMsg);
      }
    }

    if (this.interrupted) {
      callbacks.onInterrupted('');
      return;
    }

    // Stream ended without a response.completed event — commit partial text.
    if (accumulatedText) {
      callbacks.onMessage(accumulatedText, []);
    }
    callbacks.onStatus?.(null);
    callbacks.onDone(responseId, 0, 1);
  }

  // ── Chat Completions (GPT-4o and others) ──────────────────────────────────

  private async runChatCompletions(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    model: string,
    prompt: string,
    history: ChatMessage[],
    images: RunOptions['images'],
    appendSystemPrompt: string | undefined,
    callbacks: RunOptions['callbacks'],
  ): Promise<void> {
    const oaiMessages = toOpenAIMessages(history, prompt, appendSystemPrompt);

    // Attach any images to the final user message.
    if (images && images.length > 0) {
      const last = oaiMessages[oaiMessages.length - 1];
      if (last.role === 'user') {
        const parts: OAIContentPart[] = [];
        if (typeof last.content === 'string' && last.content) {
          parts.push({ type: 'text', text: last.content });
        }
        for (const img of images) {
          parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
        }
        last.content = parts;
      }
    }

    this.abortController = new AbortController();

    // Cast to any[] — OAIMessage is structurally compatible with ChatCompletionMessageParam.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await client.chat.completions.create(
      { model, messages: oaiMessages as unknown as Record<string, unknown>[], stream: true },
      { signal: this.abortController.signal },
    );

    let accumulatedText = '';

    for await (const chunk of stream) {
      if (this.interrupted) break;
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        accumulatedText += delta;
        callbacks.onToken(delta);
      }
      if (chunk.choices[0]?.finish_reason) {
        if (accumulatedText) {
          callbacks.onMessage(accumulatedText, []);
          accumulatedText = '';
        }
      }
    }

    if (this.interrupted) {
      callbacks.onInterrupted('');
      return;
    }

    // Flush any remaining streamed text.
    if (accumulatedText) {
      callbacks.onMessage(accumulatedText, []);
    }

    callbacks.onStatus?.(null);
    callbacks.onDone('', 0, 1);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.abortController?.abort();
  }

  close(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
