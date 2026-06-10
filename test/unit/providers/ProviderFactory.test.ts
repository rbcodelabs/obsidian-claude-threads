/**
 * ProviderFactory tests.
 *
 * Verifies that:
 *  1. createProvider() returns an AnthropicProvider for the default settings.
 *  2. createProvider() returns an OpenAIProvider when aiProvider === 'openai'.
 *  3. getProviderCapabilities() returns the right capability set for each provider.
 *  4. Switching provider mid-session (new call to createProvider) picks up the change.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { createProvider, getProviderCapabilities } from '../../../src/providers/ProviderFactory';
import { ANTHROPIC_CAPABILITIES } from '../../../src/providers/AnthropicProvider';
import { OPENAI_CAPABILITIES } from '../../../src/providers/OpenAIProvider';

describe('createProvider routing', () => {
  it('returns an AnthropicProvider by default (aiProvider === anthropic)', () => {
    const provider = createProvider({ ...DEFAULT_SETTINGS, aiProvider: 'anthropic' });
    // Verify identity via capabilities object reference
    expect(provider.capabilities).toEqual(ANTHROPIC_CAPABILITIES);
    expect(provider.capabilities.sessionResumption).toBe(true);
  });

  it('returns an OpenAIProvider when aiProvider === openai', () => {
    const provider = createProvider({
      ...DEFAULT_SETTINGS,
      aiProvider: 'openai',
      openAIKey: 'sk-test',
      openAIModel: 'gpt-4o',
    });
    expect(provider.capabilities).toEqual(OPENAI_CAPABILITIES);
    expect(provider.capabilities.sessionResumption).toBe(false);
  });

  it('falls back to gpt-4o model when openAIModel is empty', () => {
    // Provider should construct without throwing when model is empty
    expect(() =>
      createProvider({ ...DEFAULT_SETTINGS, aiProvider: 'openai', openAIKey: 'sk-test', openAIModel: '' }),
    ).not.toThrow();
  });

  it('creates a fresh provider instance on each call (no shared state)', () => {
    const a = createProvider({ ...DEFAULT_SETTINGS, aiProvider: 'anthropic' });
    const b = createProvider({ ...DEFAULT_SETTINGS, aiProvider: 'anthropic' });
    // Different object references — no singleton
    expect(a).not.toBe(b);
  });

  it('provider switching takes effect on next createProvider call', () => {
    const settings = { ...DEFAULT_SETTINGS };

    settings.aiProvider = 'anthropic';
    const p1 = createProvider(settings);
    expect(p1.capabilities.sessionResumption).toBe(true);

    settings.aiProvider = 'openai';
    settings.openAIKey = 'sk-test';
    const p2 = createProvider(settings);
    expect(p2.capabilities.sessionResumption).toBe(false);
  });
});

describe('getProviderCapabilities', () => {
  it('returns Anthropic capabilities for anthropic provider', () => {
    const caps = getProviderCapabilities({ ...DEFAULT_SETTINGS, aiProvider: 'anthropic' });
    expect(caps.mcpServers).toBe(true);
    expect(caps.opusEscalation).toBe(true);
  });

  it('returns OpenAI capabilities for openai provider', () => {
    const caps = getProviderCapabilities({ ...DEFAULT_SETTINGS, aiProvider: 'openai' });
    expect(caps.mcpServers).toBe(false);
    expect(caps.codeExecution).toBe(true);
  });
});
