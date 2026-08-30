import { describe, expect, it } from 'vitest';
import { isSetAsGoalEligible } from '../../src/goalContext';
import type { ChatMessage } from '../../src/types';

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: 1 };
}

describe('Set as goal message eligibility', () => {
  it('accepts the latest non-empty user message', () => {
    const messages = [message('u1', 'user', 'first'), message('a1', 'assistant', 'reply'), message('u2', 'user', '  ship this  ')];
    expect(isSetAsGoalEligible(messages, messages[2])).toBe(true);
  });

  it('rejects an older user message when a newer user message exists', () => {
    const messages = [message('u1', 'user', 'first'), message('u2', 'user', 'second')];
    expect(isSetAsGoalEligible(messages, messages[0])).toBe(false);
  });

  it.each(['assistant', 'compact', 'notice'] as const)('rejects a %s row', (role) => {
    const candidate = message('m1', role, 'content');
    expect(isSetAsGoalEligible([candidate], candidate)).toBe(false);
  });

  it('rejects blank and image-only user messages', () => {
    const blank = message('blank', 'user', '   \n ');
    const imageOnly = { ...message('image', 'user', ''), images: [{ name: 'x.png', mediaType: 'image/png', base64: 'abc' }] };
    expect(isSetAsGoalEligible([blank], blank)).toBe(false);
    expect(isSetAsGoalEligible([imageOnly], imageOnly)).toBe(false);
  });

  it('uses message identity, not equal text, to select the latest user message', () => {
    const older = message('u1', 'user', 'same');
    const latest = message('u2', 'user', 'same');
    expect(isSetAsGoalEligible([older, latest], older)).toBe(false);
    expect(isSetAsGoalEligible([older, latest], latest)).toBe(true);
  });
});
