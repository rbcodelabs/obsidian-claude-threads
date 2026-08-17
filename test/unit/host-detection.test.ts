import { describe, expect, it } from 'vitest';
import { detectHostName } from '../../src/hostEnvironment';

describe('host detection', () => {
  it('detects Geode through the window.geode compatibility marker', () => {
    expect(detectHostName({ geode: {} })).toBe('Geode');
  });

  it('defaults to Obsidian when the Geode marker is absent', () => {
    expect(detectHostName({})).toBe('Obsidian');
  });
});
