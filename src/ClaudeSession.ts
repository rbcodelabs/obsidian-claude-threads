/**
 * ClaudeSession — backward-compatibility shim.
 *
 * The session implementation has moved to src/providers/AnthropicProvider.ts.
 * SessionCallbacks is now defined in src/providers/AIProvider.ts.
 *
 * This file keeps the public surface stable so existing imports of
 * ClaudeSession, SessionCallbacks, formatToolName, and getToolIcon continue
 * to resolve without modification.
 *
 * New code should import directly from:
 *   - src/providers/AIProvider.ts       (SessionCallbacks, AIProvider interface)
 *   - src/providers/AnthropicProvider.ts (Anthropic implementation)
 *   - src/providers/ProviderFactory.ts   (createProvider)
 */

// Re-export pure utilities (mobile-safe — no SDK imports)
export { formatToolName, getToolIcon, formatToolSummary } from './toolNameUtils';

// Re-export the SessionCallbacks type from its new home
export type { SessionCallbacks } from './providers/AIProvider';

// Re-export the Anthropic provider under the original class name so that
// existing `new ClaudeSession(claudeBinaryPath)` call sites keep working.
export { AnthropicProvider as ClaudeSession } from './providers/AnthropicProvider';
