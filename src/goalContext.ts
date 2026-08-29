import type { ChatMessage } from './types';

/**
 * A goal can only be taken from the latest text-bearing human turn. Resolve
 * this from the canonical message array each time rather than trusting a DOM
 * class that may have gone stale while a context menu was open.
 */
export function isSetAsGoalEligible(messages: ChatMessage[], candidate: ChatMessage): boolean {
  if (candidate.role !== 'user' || candidate.content.trim().length === 0) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && message.content.trim().length > 0) {
      return message.id === candidate.id;
    }
  }
  return false;
}
