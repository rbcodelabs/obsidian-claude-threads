import { beforeEach, describe, expect, it, vi } from 'vitest';

const addIcon = vi.fn();

vi.mock('obsidian', () => ({ addIcon }));

describe('harness brand icons', () => {
  beforeEach(() => {
    addIcon.mockClear();
    vi.resetModules();
  });

  it('renders both official marks with the surrounding Obsidian theme color', async () => {
    await import('../../src/harnessBrandIcons');

    const registrations = new Map(addIcon.mock.calls.map(([name, svg]) => [name, svg]));
    expect(registrations.get('claude-spark')).toContain('fill="currentColor"');
    expect(registrations.get('openai-blossom')).toContain('fill="currentColor"');
    expect(registrations.get('claude-spark')).not.toContain('#D97757');
  });
});
