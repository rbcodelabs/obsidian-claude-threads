import type { ChatMessage } from './types';
import type { SummarizeResult } from './InProcessSummarizer';

export class SummarizationService {
  async summarize(
    messages: ChatMessage[],
    endpoint: string,
    model: string,
  ): Promise<SummarizeResult> {
    const transcript = messages
      .slice(-30)
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 800)}`)
      .join('\n\n');

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a concise summarizer. Given a conversation, output ONLY a JSON object with two fields: ' +
            '"title" (a 3-5 word tab title, e.g. "Fix auth middleware bug") and ' +
            '"summary" (a 2-3 sentence summary of what is being worked on, key decisions, and current status). ' +
            'No markdown fences, no other text — pure JSON only.',
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${transcript}`,
        },
      ],
      stream: false,
      temperature: 0.3,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Summarization request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) throw new Error(data.error.message);

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('No summary returned from model');

    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      return {
        title: String(parsed.title ?? '').trim(),
        summary: String(parsed.summary ?? '').trim(),
      };
    } catch {
      return { title: '', summary: text };
    }
  }
}
