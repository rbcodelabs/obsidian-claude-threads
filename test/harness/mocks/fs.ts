const SKILL_DESCRIPTIONS: Record<string, string> = {
  'brain-dump': 'Interactive knowledge extraction — structured interview to capture tacit knowledge and save notes to your Obsidian vault.',
  'brainstorm': 'Active ideation partner — Claude leads the session, proposes angles, surfaces frameworks, and produces a structured Obsidian ideation doc.',
  'dsql': 'Build with Aurora DSQL — manage schemas, execute queries, and handle migrations with DSQL-specific requirements.',
  'vercel-tools': 'Vercel CLI recipes — check deploy status, apply migrations to preview/production, watch deployments, and debug failed builds.',
  'nextjs-local-dev': 'Manage a local Next.js dev server — start, stop, restart, monitor logs — with safe isolation across git worktrees.',
};

export default {
  existsSync: (_p: string) => false,
  readdirSync: (_p: string): string[] => Object.keys(SKILL_DESCRIPTIONS),
  readFileSync: (p: string, _enc: string): string => {
    const name = p.split('/').pop() ?? '';
    const desc = SKILL_DESCRIPTIONS[name] ?? 'A Claude Code skill.';
    return `---\nname: ${name}\ndescription: ${desc}\n---\n`;
  },
  statSync: (_p: string) => ({ isDirectory: () => false }),
};
