#!/usr/bin/env bash
#
# Reference status-line script for the Claude Threads "Context footer command".
#
# Emits a JSON array of status tags (see the StatusTag type / ADR-0001), so the
# plugin can render typed pills and derive the thread's PR url from a kind:"pr"
# tag — no prose scanning. Plaintext output still works (legacy fallback), but
# JSON lets you split branch/PR/dev/AWS into distinct, clickable pills.
#
# stdin: { "cwd": "...", "workspace": { "current_dir": "..." } }
# stdout: [{ "label": "...", "url": "...", "kind": "...", "tone": "..." }, ...]
#
# Requires: jq, git, gh (and optionally aws). The plugin prepends the common
# Homebrew/local bin dirs to PATH, so these resolve under Obsidian's exec env.

input=$(cat)
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
provider=$(echo "$input" | jq -r '.provider // empty')

branch=""; remote=""
if [ -n "$cwd" ]; then
  branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
  remote=$(git -C "$cwd" --no-optional-locks remote get-url origin 2>/dev/null)
fi

tags='[]'
add() { tags=$(jq -c --argjson t "$1" '. + [$t]' <<<"$tags"); }

# dev url — nextdev port lookup with an alive check
if [ -n "$cwd" ]; then
  abs_cwd=$(cd "$cwd" && pwd -P 2>/dev/null)
  if [ -n "$abs_cwd" ]; then
    hash=$(printf '%s' "$abs_cwd" | shasum | cut -c1-12)
    sd="${XDG_STATE_HOME:-$HOME/.local/state}/nextdev/$hash"
    if [ -f "$sd/port" ] && [ -f "$sd/pid" ]; then
      pid=$(cat "$sd/pid"); port=$(cat "$sd/port")
      if kill -0 "$pid" 2>/dev/null; then
        add "$(jq -nc --arg u "http://localhost:$port" '{label:$u,url:$u,kind:"dev"}')"
      fi
    fi
  fi
fi

# branch
[ -n "$branch" ] && add "$(jq -nc --arg b "$branch" '{label:$b,kind:"branch"}')"

# PR for the branch — emit a url so the plugin derives prUrl correctly
if [ -n "$branch" ] && [ -n "$remote" ]; then
  pr_json=$(gh pr view "$branch" --repo "$remote" --json number,url 2>/dev/null)
  if [ -n "$pr_json" ]; then
    n=$(jq -r '.number' <<<"$pr_json"); u=$(jq -r '.url' <<<"$pr_json")
    add "$(jq -nc --arg l "PR #$n" --arg u "$u" '{label:$l,url:$u,kind:"pr"}')"
  fi
fi

# AWS SSO status with tone — only relevant when Claude routes through Bedrock.
# The plugin passes the active provider on stdin; skip the check otherwise so a
# logged-out AWS session doesn't show a spurious "AWS expired" pill.
if [ "$provider" = "bedrock" ] && command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity --query Account --output text >/dev/null 2>&1; then
    add "$(jq -nc '{label:"AWS ok",kind:"aws"}')"
  else
    add "$(jq -nc '{label:"AWS expired",tone:"warn",kind:"aws"}')"
  fi
fi

printf '%s' "$tags"
