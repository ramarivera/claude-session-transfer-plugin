---
description: Transfer the current Claude Code session into a resumable OMP session JSONL
argument-hint: "[--source <claude-jsonl>] [--output <omp-jsonl>] [--cwd <cwd>] [--model <model>] [--open] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/session-transfer.mjs" omp "$ARGUMENTS"`

Present the command output exactly as returned. Preserve the `omp --resume <path>` resume command.
