import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/SkillsManagerView';

describe('parseFrontmatter', () => {
  it('returns empty strings when no frontmatter block is present', () => {
    expect(parseFrontmatter('# Just a heading\nsome body text')).toEqual({
      name: '',
      description: '',
    });
  });

  it('parses an inline description value', () => {
    const content = `---
name: my-skill
description: Short inline description
---
# Body
`;
    expect(parseFrontmatter(content)).toEqual({
      name: 'my-skill',
      description: 'Short inline description',
    });
  });

  it('strips surrounding quotes from an inline description', () => {
    const content = `---
name: quoted-skill
description: "A quoted description"
---
`;
    expect(parseFrontmatter(content)).toEqual({
      name: 'quoted-skill',
      description: 'A quoted description',
    });
  });

  it('parses a >- folded block scalar description into a single joined string', () => {
    // This is the exact pattern used by agent-pm-playbook SKILL.md files.
    // Before the fix, parseFrontmatter returned ">-" as the description.
    const content = `---
name: pm-setup
description: >-
  Configure your PM environment. Run once when adopting the Agentic PM Playbook.
  Asks about your notes system, issue tracker, OKR cycle, and current desired
  outcome, then writes a pm-config.md.
retrieval:
  aliases:
    - pm setup
---
`;
    const { name, description } = parseFrontmatter(content);
    expect(name).toBe('pm-setup');
    // Must not be the raw indicator
    expect(description).not.toBe('>-');
    // Must contain content from all three continuation lines joined into one string
    expect(description).toContain('Configure your PM environment');
    expect(description).toContain('Asks about your notes system');
    expect(description).toContain('pm-config.md');
    // Must be a single line (folded), not contain newlines
    expect(description).not.toMatch(/\n/);
  });

  it('parses a > folded block scalar (no strip indicator) the same way', () => {
    const content = `---
name: folded-skill
description: >
  First line of description.
  Second line continues here.
---
`;
    const { description } = parseFrontmatter(content);
    expect(description).toContain('First line of description');
    expect(description).toContain('Second line continues here');
    expect(description).not.toMatch(/\n/);
  });

  it('parses a |- literal block scalar description preserving newlines', () => {
    const content = `---
name: literal-skill
description: |-
  First line.
  Second line.
---
`;
    const { description } = parseFrontmatter(content);
    expect(description).toContain('First line.');
    expect(description).toContain('Second line.');
    expect(description).toMatch(/\n/);
  });

  it('parses a | literal block scalar preserving newlines', () => {
    const content = `---
name: literal-skill2
description: |
  Line one.
  Line two.
---
`;
    const { description } = parseFrontmatter(content);
    expect(description).toMatch(/Line one\.\nLine two\./);
  });

  it('joins multiple folded lines with a space and preserves intra-line whitespace', () => {
    // Folded style joins continuation lines with a single space between them.
    // Whitespace within a single line is preserved as-is.
    const content = `---
name: multi-line
description: >-
  First sentence here.
  Second sentence here.
---
`;
    const { description } = parseFrontmatter(content);
    expect(description).toBe('First sentence here. Second sentence here.');
  });

  it('stops collecting block scalar lines at the next non-indented key', () => {
    const content = `---
name: pm-setup
description: >-
  Configure your PM environment.
  This is the second line.
retrieval:
  aliases:
    - something
---
`;
    const { description } = parseFrontmatter(content);
    // Should not include "retrieval:" or anything after it
    expect(description).not.toContain('retrieval');
    expect(description).toContain('Configure your PM environment');
    expect(description).toContain('This is the second line');
  });

  it('returns empty description when description key is missing', () => {
    const content = `---
name: no-desc
---
# Body
`;
    expect(parseFrontmatter(content)).toEqual({ name: 'no-desc', description: '' });
  });
});
