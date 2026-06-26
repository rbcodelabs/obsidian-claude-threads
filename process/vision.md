# Claude Threads: Vision

## The Problem

Claude Code changed how power users work with AI. The real unlock wasn't single-turn chat — it was agentic tasks: hand Claude a real job, let it run for 5-10 minutes, touch a lot of files, and come back with something done. Once you start running tasks like that, you naturally want to run several at once.

The terminal handles this badly. You end up in a grid of tmux panes, losing track of which agent is doing what, constantly switching windows. And your notes, specs, and context live somewhere else entirely — usually Obsidian.

## Who It's For

Power users of Claude Code who:
- Run multi-step agentic tasks, not just one-turn chat
- Work from Obsidian (notes, specs, CLAUDE.md, project docs live there)
- Want to run several agents in parallel and manage them from one place
- Use skills, worktrees, and MCP, and don't want a wrapper that strips those capabilities away

Not for: casual users who want a chatbot UI. Claude.ai already does that well.

## The Core Insight

Your thinking environment and your agent fleet shouldn't be in different applications.

When your specs, architecture notes, and daily scratchpad live in Obsidian, and your agents are running in a separate terminal window, you're context-switching constantly. Claude Threads collapses that gap. Write a spec, then dispatch a thread to implement it — right there, without switching windows, losing focus, or breaking flow.

## What Makes It Different

**1. Agentic-first, not chat-first**
Every design decision assumes the primary use case is a long-running task, not a quick question. Threads run in the background. You glance at them. You dispatch more. The dashboard is the default view, not an afterthought.

**2. Multi-agent dashboard**
No other Obsidian plugin — and very few Claude UIs — let you monitor multiple independent sessions at once. See what every agent is doing, dispatch new ones, resolve permission dialogs, all without switching threads. This is the capability that doesn't exist anywhere else.

**3. Full Claude Code fidelity**
Claude Threads wraps the actual CLI subprocess. Skills, CLAUDE.md files, worktrees, MCP servers, Bedrock routing: all of it just works. We don't rebuild the agent experience; we surface it inside Obsidian.

**4. Vault-native context**
`@file` mentions, Projects with shared context prompts, thread notes saved back to the vault, session history browsable as Obsidian notes. The vault is the connective tissue between your thinking and your agents, not a separate silo.

**5. Ambient, not interruptive**
The design principle: you should be able to glance at Claude Threads the way you glance at a progress bar. Not be forced to focus on it. Context recap banners, thread summaries, the status rail — these all reduce the cognitive overhead of running a parallel workload so you can stay in flow on your own work.

## North Star

**Claude Threads should be the best place to run and manage an agentic AI workload, for people whose thinking lives in Obsidian.**

A user should be able to:
- Kick off 3-5 parallel tasks in under 30 seconds
- Know the state of every running agent at a glance
- Pull vault context into a new task seamlessly (notes, specs, open files)
- Stay in their thinking environment the whole time, never bouncing between apps

## Near-Term Priorities

### 1. Submit to Obsidian Community Plugins
The biggest leverage point right now is discoverability. We're BRAT-only, which means only early adopters find us. Getting into the official plugin directory is the top near-term goal. Pre-requisites: pass Obsidian's review criteria, complete user documentation, polished onboarding.

### 2. Onboarding and Activation
The first-run guide exists but the onboarding arc isn't complete. A new user needs to understand: (a) what Claude Threads is for, (b) how to install Claude Code if they haven't, (c) how to run their first agentic task. The gap between "plugin installed" and "first successful agentic task" is still too wide.

### 3. Public Roadmap
Move feature requests and planned work into Compass so users can see what's coming and vote on priorities.

### 4. Lightweight Documentation Site
The README is good but not enough for new users. A docs site covering guides, use cases, the skill system, and worktrees would reduce the activation energy significantly.

## What We're Deliberately Not

- A Claude.ai replacement for casual chat
- A generic AI chat plugin (there are many of those)
- A product that abstracts away Claude Code (we embrace the CLI, skills, and MCP as first-class)
- Cloud-hosted (local-first is a feature, not a limitation)
