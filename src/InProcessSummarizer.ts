import { spawn } from 'child_process';
import type { ChatMessage } from './types';
import { parseExtraEnv } from './types';

type ProgressCallback = (status: string) => void;

export class InProcessSummarizer {
  async summarize(
    messages: ChatMessage[],
    claudeBinary: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const transcript = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 600)}`)
      .join('\n\n')
      .slice(0, 3000);

    const prompt =
      'Summarize this conversation in 2-3 sentences covering what is being worked on, ' +
      'key decisions made, and current status. Be specific about files, projects, or tasks mentioned.\n\n' +
      transcript;

    onProgress?.('Summarizing…');

    return new Promise((resolve, reject) => {
      const proc = spawn(claudeBinary, ['--print', '--model', modelAlias], {
        env: { ...process.env, ...parseExtraEnv(extraEnv) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errOutput = '';

      proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { errOutput += d.toString(); });
      proc.on('error', (err: Error) => reject(err));
      proc.on('close', (code: number | null) => {
        if (code === 0 && output.trim()) resolve(output.trim());
        else reject(new Error(errOutput.trim() || `claude exited with code ${code}`));
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  unload(): void {}
}
