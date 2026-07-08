# Claude Session Transfer Plugin

Claude Code marketplace plugin that converts the current Claude Code transcript into resumable Pi or OMP session JSONL files.

## Commands

- `/session-transfer:pi` writes a Pi session and prints `pi --session <path>`.
- `/session-transfer:omp` writes an OMP session and prints `omp --resume <path>`.

Both commands accept:

```text
[--source <claude-jsonl>] [--output <target-jsonl>] [--cwd <cwd>] [--model <model>] [--open] [--json]
```

If `--source` is omitted, the plugin checks `CLAUDE_SESSION_FILE`, `CLAUDE_TRANSCRIPT_PATH`, `CODEX_COMPANION_TRANSCRIPT_PATH`, then the newest transcript under the current Claude project directory.

## Install

```bash
claude plugin marketplace add ramarivera/claude-session-transfer-plugin
claude plugin marketplace update toolbox-session-transfer
claude plugin install session-transfer@toolbox-session-transfer --scope user
```

## Development

```bash
npm test
claude plugin validate .
claude plugin validate plugins/session-transfer
```

The tests include a synthetic Claude Code transcript fixture and verify both conversion output and loading through installed Pi/OMP runtimes when available at the default toolbox-managed paths.
