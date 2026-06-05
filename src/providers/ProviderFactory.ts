/**
 * ProviderFactory — reads PluginSettings and returns the configured AIProvider.
 *
 * Both provider modules are statically imported. This is safe because
 * ProviderFactory itself is only reached via ThreadManager, which is
 * already lazy-required inside onloadDesktop() in main.ts. So these
 * imports never execute at mobile bundle init time.
 */

import type { AIProvider } from './AIProvider';
import type { PluginSettings } from '../types';
import { AnthropicProvider, ANTHROPIC_CAPABILITIES } from './AnthropicProvider';
import { OpenAIProvider, OPENAI_CAPABILITIES } from './OpenAIProvider';

/**
 * Return a fresh AIProvider instance for the current settings.
 * Call this at the start of each sendMessage() so provider changes take effect
 * without a plugin reload.
 */
export function createProvider(settings: PluginSettings): AIProvider {
  if (settings.aiProvider === 'openai') {
    return new OpenAIProvider(
      settings.openAIKey,
      settings.openAIModel || 'gpt-4o',
      settings.openAICodeExecution ?? false,
    );
  }

  // Default: Anthropic Claude Agent SDK
  return new AnthropicProvider(settings.claudeBinaryPath);
}

/**
 * Convenience: return the capabilities for the currently configured provider
 * without constructing a full provider instance. Useful for rendering UI
 * feature gates before a session starts.
 */
export function getProviderCapabilities(settings: PluginSettings) {
  if (settings.aiProvider === 'openai') {
    return OPENAI_CAPABILITIES;
  }
  return ANTHROPIC_CAPABILITIES;
}
