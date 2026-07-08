---
description: Transfer the current Claude Code session into a resumable Pi session JSONL
argument-hint: "[--source <claude-jsonl>] [--output <pi-jsonl>] [--cwd <cwd>] [--model <model>] [--open] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/session-transfer.mjs" pi "$ARGUMENTS"`

Present the command output exactly as returned. Preserve the `pi --session <path>` resume command.
