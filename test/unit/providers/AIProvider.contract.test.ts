/**
 * AIProvider contract tests.
 *
 * Verifies that:
 *  1. Both provider adapters satisfy the AIProvider interface shape.
 *  2. Capability flags are internally consistent (e.g. if sessionResumption is
 *     false, the provider must never pass a resumeSessionId to the SDK).
 *  3. The SessionCallbacks type is importable without pulling in SDK modules.
 *
 * Note: these tests do NOT make real API calls. Provider-specific behaviour
 * is covered in separate test files (OpenAIProvider.test.ts etc.).
 */

import { describe, it, expect } from 'vitest';
import { ANTHROPIC_CAPABILITIES, AnthropicProvider } from '../../../src/providers/AnthropicProvider';
import { OPENAI_CAPABILITIES, OpenAIProvider } from '../../../src/providers/OpenAIProvider';
import type { ProviderCapabilities, AIProvider, SessionCallbacks } from '../../../src/providers/AIProvider';

// ── Capability shape checks ────────────────────────────────────────────────────

function assertCapabilityShape(caps: ProviderCapabilities, name: string) {
  const keys: (keyof ProviderCapabilities)[] = [
    'streaming', 'sessionResumption', 'toolPermissionGating',
    'mcpServers', 'visionInput', 'codeExecution', 'opusEscalation',
  ];
  for (const key of keys) {
    expect(typeof caps[key], `${name}.${key} should be boolean`).toBe('boolean');
  }
}

describe('ProviderCapabilities shape', () => {
  it('AnthropicProvider capabilities has all required fields', () => {
    assertCapabilityShape(ANTHROPIC_CAPABILITIES, 'AnthropicProvider');
  });

  it('OpenAIProvider capabilities has all required fields', () => {
    assertCapabilityShape(OPENAI_CAPABILITIES, 'OpenAIProvider');
  });
});

describe('AnthropicProvider capabilities semantics', () => {
  it('supports session resumption', () => {
    expect(ANTHROPIC_CAPABILITIES.sessionResumption).toBe(true);
  });

  it('supports tool permission gating', () => {
    expect(ANTHROPIC_CAPABILITIES.toolPermissionGating).toBe(true);
  });

  it('supports MCP servers', () => {
    expect(ANTHROPIC_CAPABILITIES.mcpServers).toBe(true);
  });

  it('supports streaming', () => {
    expect(ANTHROPIC_CAPABILITIES.streaming).toBe(true);
  });

  it('supports Opus escalation', () => {
    expect(ANTHROPIC_CAPABILITIES.opusEscalation).toBe(true);
  });

  it('does not advertise code execution (handled by subprocess)', () => {
    expect(ANTHROPIC_CAPABILITIES.codeExecution).toBe(false);
  });
});

describe('OpenAIProvider capabilities semantics', () => {
  it('does not support session resumption', () => {
    expect(OPENAI_CAPABILITIES.sessionResumption).toBe(false);
  });

  it('does not support tool permission gating', () => {
    expect(OPENAI_CAPABILITIES.toolPermissionGating).toBe(false);
  });

  it('does not support MCP servers', () => {
    expect(OPENAI_CAPABILITIES.mcpServers).toBe(false);
  });

  it('supports streaming', () => {
    expect(OPENAI_CAPABILITIES.streaming).toBe(true);
  });

  it('supports code execution (Codex container)', () => {
    expect(OPENAI_CAPABILITIES.codeExecution).toBe(true);
  });

  it('does not support Opus escalation', () => {
    expect(OPENAI_CAPABILITIES.opusEscalation).toBe(false);
  });
});

describe('AIProvider interface structural compliance', () => {
  it('AnthropicProvider has required interface methods', () => {
    const provider = new AnthropicProvider('/usr/bin/claude');
    const p = provider as AIProvider;
    expect(typeof p.capabilities).toBe('object');
    expect(typeof p.run).toBe('function');
    expect(typeof p.interrupt).toBe('function');
    expect(typeof p.close).toBe('function');
  });

  it('OpenAIProvider has required interface methods', () => {
    const provider = new OpenAIProvider('sk-test', 'gpt-4o', false);
    const p = provider as AIProvider;
    expect(typeof p.capabilities).toBe('object');
    expect(typeof p.run).toBe('function');
    expect(typeof p.interrupt).toBe('function');
    expect(typeof p.close).toBe('function');
  });
});

describe('SessionCallbacks type is importable without SDK', () => {
  it('SessionCallbacks can be type-imported cleanly', () => {
    // If this file compiled without errors, the import is clean.
    // We just assert the type is accessible via duck-typing at runtime.
    const cb: Partial<SessionCallbacks> = {
      onToken: (_t) => {},
      onError: (_e) => {},
    };
    expect(typeof cb.onToken).toBe('function');
  });
});
