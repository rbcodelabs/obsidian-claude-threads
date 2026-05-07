import type { ChatMessage } from './types';

export class SummarizationService {
  async summarize(
    messages: ChatMessage[],
    endpoint: string,
    model: string,
  ): Promise<string> {
    const transcript = messages
      .slice(-30) // cap at last 30 messages to stay within context
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 800)}`)
      .join('\n\n');

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a concise summarizer. Summarize the conversation in 2-3 sentences. Focus on what is being worked on, any key decisions, and current status. Be specific about files, projects, or tasks mentioned.',
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
    return text;
  }
}
