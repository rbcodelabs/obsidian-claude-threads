/**
 * Regression tests for the harness (Codex) tool-result adapter.
 *
 * `toHarnessDynamicTools` flattens an MCP tool result's content blocks into one
 * plain-text payload. It used to do that with
 * `item.type === 'text' ? item.text : JSON.stringify(item)`, which means the
 * first tool to return an image block would drop multiple megabytes of base64
 * straight into a Codex context window.
 *
 * The fix has to live in the adapter, not in the tool handlers:
 * `toHarnessDynamicTools` invokes `toolDefinition.handler` directly, so a
 * handler cannot know whether it is being called on the harness path (where the
 * payload is useless) or over MCP (where the image block is the whole point).
 *
 * The `text.length` upper bounds below are the load-bearing assertions: they
 * are what stops a base64 blob regressing back in.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name, description, inputSchema, handler,
  }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { toHarnessDynamicTools, harnessTextFromToolContent } from '../../src/ObsidianTools';

/** ~2 MB of base64: a plausible full-screen PNG. */
const BIG_BASE64 = 'A'.repeat(2 * 1024 * 1024);

/** No placeholder should ever be longer than a short sentence. */
const PLACEHOLDER_MAX_LENGTH = 120;

type ContentBlock = Record<string, unknown>;

/**
 * Build a harness tool whose handler returns exactly `content`, then invoke it.
 * Goes through the real `toHarnessDynamicTools` rather than the helper so the
 * adapter's own wiring is covered, not just the formatter.
 */
async function invokeWithContent(content: ContentBlock[], isError = false): Promise<{ success: boolean; text: string }> {
  const definition = {
    name: 'test_tool',
    description: 'returns fixed content',
    inputSchema: {} as Record<string, z.ZodTypeAny>,
    handler: async () => ({ content, ...(isError ? { isError: true } : {}) }),
  };
  const [harnessTool] = toHarnessDynamicTools([definition as never]);
  return harnessTool!.invoke({});
}

const anthropicImage = (mediaType: string, data: string): ContentBlock => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data },
});

const mcpImage = (mimeType: string, data: string): ContentBlock => ({ type: 'image', data, mimeType });

describe('toHarnessDynamicTools: image blocks never reach the harness as base64', () => {
  it('replaces an Anthropic-shaped image block with a short placeholder', async () => {
    const { success, text } = await invokeWithContent([anthropicImage('image/png', BIG_BASE64)]);

    expect(success).toBe(true);
    expect(text).not.toContain(BIG_BASE64);
    expect(text).not.toMatch(/A{100}/);
    expect(text).toMatch(/^\[image: image\/png, \d+kB\]$/);
    expect(text.length).toBeLessThanOrEqual(PLACEHOLDER_MAX_LENGTH);
  });

  it('replaces an MCP-shaped image block with a short placeholder', async () => {
    const { text } = await invokeWithContent([mcpImage('image/jpeg', BIG_BASE64)]);

    expect(text).not.toContain(BIG_BASE64);
    expect(text).toMatch(/^\[image: image\/jpeg, \d+kB\]$/);
    expect(text.length).toBeLessThanOrEqual(PLACEHOLDER_MAX_LENGTH);
  });

  it('keeps text blocks verbatim and preserves block order around an image', async () => {
    const { text } = await invokeWithContent([
      { type: 'text', text: 'Saved to Agent Threads/attachments/captures/window.png' },
      anthropicImage('image/png', BIG_BASE64),
      { type: 'text', text: 'done' },
    ]);

    const lines = text.split('\n');
    expect(lines[0]).toBe('Saved to Agent Threads/attachments/captures/window.png');
    expect(lines[1]).toMatch(/^\[image: image\/png, \d+kB\]$/);
    expect(lines[2]).toBe('done');
    expect(text).not.toContain(BIG_BASE64);
  });

  it('holds the length bound even when a result carries several large images', async () => {
    const { text } = await invokeWithContent([
      { type: 'text', text: 'three windows' },
      anthropicImage('image/png', BIG_BASE64),
      mcpImage('image/png', BIG_BASE64),
      anthropicImage('image/webp', BIG_BASE64),
    ]);

    expect(text).not.toContain(BIG_BASE64);
    // 'three windows' plus three placeholders and their newlines.
    expect(text.length).toBeLessThanOrEqual(PLACEHOLDER_MAX_LENGTH * 4);
  });

  it('still surfaces isError and still JSON-stringifies non-text, non-image blocks', async () => {
    const { success, text } = await invokeWithContent(
      [{ type: 'resource', uri: 'file:///tmp/x' }],
      true,
    );

    expect(success).toBe(false);
    expect(text).toBe(JSON.stringify({ type: 'resource', uri: 'file:///tmp/x' }));
  });

  it('reports a plausible size and degrades gracefully on a payload-free image block', () => {
    // 4 base64 chars encode 3 bytes, so 1 MB of base64 is ~768 kB of image.
    expect(harnessTextFromToolContent([anthropicImage('image/png', 'A'.repeat(1024 * 1024))]))
      .toBe('[image: image/png, 768kB]');
    expect(harnessTextFromToolContent([{ type: 'image', mimeType: 'image/png' }]))
      .toBe('[image: image/png]');
    expect(harnessTextFromToolContent([{ type: 'image' }])).toBe('[image: image]');
  });
});
