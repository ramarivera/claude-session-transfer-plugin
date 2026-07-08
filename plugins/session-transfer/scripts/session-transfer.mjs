#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SESSION_VERSION = 3;
const DEFAULT_MODEL = "claude-sonnet-4-5";
const TRANSCRIPT_PATH_ENVS = [
  "CLAUDE_SESSION_FILE",
  "CLAUDE_TRANSCRIPT_PATH",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
];

function usage(exitCode = 0) {
  const text = `Usage: session-transfer <pi|omp> [--source <claude-jsonl>] [--output <target-jsonl>] [--cwd <cwd>] [--model <model>] [--open] [--json]

Converts a Claude Code transcript JSONL into a Pi or OMP v3 session JSONL.

Options:
  --source <path>   Claude Code JSONL source. Defaults to env/current project heuristic.
  --output <path>   Target JSONL path. Defaults under ~/.pi/agent/sessions or ~/.omp/agent/sessions.
  --cwd <path>      Workspace cwd to store in the target session header. Defaults to transcript cwd or process cwd.
  --model <model>   Fallback model id when the Claude transcript has no assistant model.
  --open            Launch the target CLI after writing the session.
  --json            Print machine-readable JSON.
  --help            Show this help.
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(text);
  process.exit(exitCode);
}

function tokenizeArgumentString(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error(`Unclosed quote in arguments: ${input}`);
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function normalizeClaudeArguments(argv) {
  if (argv.length <= 1) return argv;
  const [target, maybeArgumentString, ...rest] = argv;
  if ((target === "pi" || target === "omp") && rest.length === 0 && maybeArgumentString.includes(" ")) {
    return [target, ...tokenizeArgumentString(maybeArgumentString)];
  }
  return argv;
}

function parseArgs(rawArgv) {
  const argv = normalizeClaudeArguments(rawArgv);
  const out = { positional: [], source: undefined, output: undefined, cwd: undefined, model: DEFAULT_MODEL, open: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--open") {
      out.open = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (["--source", "--output", "--cwd", "--model"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      out[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      out.positional.push(arg);
    }
  }
  const target = out.positional[0];
  if (target !== "pi" && target !== "omp") {
    throw new Error("First argument must be pi or omp");
  }
  if (out.positional.length > 1) {
    throw new Error(`Unexpected positional arguments: ${out.positional.slice(1).join(" ")}`);
  }
  return { ...out, target };
}

function expandUser(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolvePathFrom(cwd, value) {
  const expanded = expandUser(String(value));
  return path.resolve(cwd, expanded);
}

function claudeProjectsDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, "projects")
    : path.join(os.homedir(), ".claude", "projects");
}

function slugClaudeProjectDir(cwd) {
  return cwd.replace(/[/\\]/g, "-");
}

function newestJsonlInDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.full;
}

function resolveClaudeSource(cwd, explicitSource) {
  if (explicitSource) {
    const source = resolvePathFrom(cwd, explicitSource);
    assertReadableJsonl(source);
    return source;
  }

  for (const envName of TRANSCRIPT_PATH_ENVS) {
    const value = process.env[envName];
    if (!value) continue;
    const source = resolvePathFrom(cwd, value);
    if (fs.existsSync(source)) {
      assertReadableJsonl(source);
      return source;
    }
  }

  const projectDir = path.join(claudeProjectsDir(), slugClaudeProjectDir(cwd));
  const newest = newestJsonlInDir(projectDir);
  if (newest) return newest;
  throw new Error(`Could not find a Claude transcript. Pass --source <path>. Checked ${projectDir}`);
}

function assertReadableJsonl(file) {
  if (path.extname(file) !== ".jsonl") throw new Error(`Expected a .jsonl file: ${file}`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on ${file}:${index + 1}: ${error.message}`);
      }
    });
}

function timestampMs(value, fallback = Date.now()) {
  if (typeof value === "number") {
    if (value >= 1_000_000_000 && value < 10_000_000_000) return value * 1000;
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function iso(value, fallback = Date.now()) {
  return new Date(timestampMs(value, fallback)).toISOString();
}

function idFactory() {
  const used = new Set();
  return function id() {
    for (;;) {
      const candidate = crypto.randomBytes(4).toString("hex");
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };
}

function normalizeContentList(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  return [{ type: "text", text: String(content) }];
}

function textBlocksFromClaude(value) {
  const content = normalizeContentList(value);
  const blocks = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) blocks.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" || block.type === "input_text" || block.type == null) {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) blocks.push({ type: "text", text });
    } else if (block.type === "image" && typeof block.data === "string") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mime_type || block.mimeType || "image/png" });
    }
  }
  return blocks;
}

function toolResultContentToBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    if (content == null) return [];
    return [{ type: "text", text: JSON.stringify(content) }];
  }
  const blocks = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) blocks.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" || item.type == null) {
      const text = typeof item.text === "string" ? item.text : "";
      if (text) blocks.push({ type: "text", text });
    } else if (item.type === "image" && typeof item.source?.data === "string") {
      blocks.push({ type: "image", data: item.source.data, mimeType: item.source.media_type || "image/png" });
    } else if (item.type === "image" && typeof item.data === "string") {
      blocks.push({ type: "image", data: item.data, mimeType: item.mime_type || item.mimeType || "image/png" });
    } else {
      blocks.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  return blocks;
}

function usageFromClaude(usage) {
  const input = Number(usage?.input_tokens ?? usage?.input ?? 0) || 0;
  const output = Number(usage?.output_tokens ?? usage?.output ?? 0) || 0;
  const cacheRead = Number(usage?.cache_read_input_tokens ?? usage?.cacheRead ?? 0) || 0;
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? usage?.cacheWrite ?? 0) || 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function stopReasonFromClaude(value) {
  if (value === "tool_use") return "toolUse";
  if (value === "max_tokens") return "length";
  if (value === "error") return "error";
  return "stop";
}

function assistantContentFromClaude(content) {
  const blocks = [];
  for (const block of normalizeContentList(content)) {
    if (typeof block === "string") {
      if (block) blocks.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" || block.type === "input_text" || block.type == null) {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) blocks.push({ type: "text", text });
    } else if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : (typeof block.text === "string" ? block.text : "");
      if (thinking) blocks.push({ type: "thinking", thinking, thinkingSignature: block.signature });
    } else if (block.type === "tool_use") {
      const toolId = block.id || `toolu_${crypto.randomUUID()}`;
      blocks.push({ type: "toolCall", id: toolId, name: block.name || "unknown", arguments: block.input && typeof block.input === "object" ? block.input : {} });
    }
  }
  return blocks;
}

function toolResultsFromClaudeUserContent(content, ts) {
  const results = [];
  for (const block of normalizeContentList(content)) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
    const contentBlocks = toolResultContentToBlocks(block.content);
    results.push({
      role: "toolResult",
      toolCallId: block.tool_use_id || block.toolCallId || "unknown",
      toolName: block.name || block.tool_name || "unknown",
      content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
      isError: Boolean(block.is_error || block.isError),
      timestamp: ts,
    });
  }
  return results;
}

function userTextContentExcludingToolResults(content) {
  const contentList = normalizeContentList(content).filter((block) => !(block && typeof block === "object" && block.type === "tool_result"));
  return textBlocksFromClaude(contentList);
}

function inferToolNames(messages) {
  const names = new Map();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "toolCall") names.set(block.id, block.name);
    }
  }
  for (const message of messages) {
    if (message.role === "toolResult" && (!message.toolName || message.toolName === "unknown")) {
      message.toolName = names.get(message.toolCallId) || message.toolName || "unknown";
    }
  }
}

function convertClaudeEvents(events, options) {
  const fallbackNow = Date.now();
  const cwd = path.resolve(options.cwd || events.find((event) => typeof event.cwd === "string")?.cwd || process.cwd());
  const sessionId = crypto.randomUUID();
  const firstTimestamp = events.find((event) => event.timestamp)?.timestamp;
  const header = { type: "session", version: SESSION_VERSION, id: sessionId, timestamp: iso(firstTimestamp, fallbackNow), cwd, parentSession: options.source };
  const messages = [];
  let model = options.model || DEFAULT_MODEL;

  for (const event of events) {
    if (event.type !== "user" && event.type !== "assistant") continue;
    const msg = event.message || {};
    const role = msg.role || event.type;
    const ts = timestampMs(event.timestamp, fallbackNow);
    if (role === "user") {
      const userContent = userTextContentExcludingToolResults(msg.content);
      if (userContent.length > 0) {
        messages.push({ role: "user", content: userContent, timestamp: ts });
      }
      messages.push(...toolResultsFromClaudeUserContent(msg.content, ts));
    } else if (role === "assistant") {
      const content = assistantContentFromClaude(msg.content);
      if (content.length === 0) continue;
      if (typeof msg.model === "string" && msg.model.trim()) model = msg.model.trim();
      messages.push({
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model,
        usage: usageFromClaude(msg.usage),
        stopReason: stopReasonFromClaude(msg.stop_reason || msg.stopReason),
        responseId: msg.id,
        timestamp: ts,
      });
    }
  }

  inferToolNames(messages);
  if (messages.length === 0) throw new Error("No user/assistant/tool-result messages found in Claude transcript");
  return { header, messages, model, cwd };
}

function makeModelChange(target, id, timestamp, parentId, model) {
  if (target === "pi") {
    return { type: "model_change", id, parentId, timestamp, provider: "anthropic", modelId: model };
  }
  return { type: "model_change", id, parentId, timestamp, model: `anthropic/${model}`, role: "default" };
}

function buildTargetEntries(target, converted) {
  const nextId = idFactory();
  const entries = [converted.header];
  let parentId = null;
  const modelEntryId = nextId();
  entries.push(makeModelChange(target, modelEntryId, converted.header.timestamp, parentId, converted.model));
  parentId = modelEntryId;

  for (const message of converted.messages) {
    const entryId = nextId();
    const ts = iso(message.timestamp);
    entries.push({ type: "message", id: entryId, parentId, timestamp: ts, message });
    parentId = entryId;
  }
  return entries;
}

function encodePiSessionDir(cwd) {
  const safePath = path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${safePath}--`;
}

function encodeOmpSessionDir(cwd) {
  const resolved = path.resolve(cwd);
  const home = os.homedir();
  const tmp = os.tmpdir();
  const encode = (value) => value.replace(/[/\\:]/g, "-");
  const relativeHome = path.relative(home, resolved);
  if (relativeHome === "") return "-";
  if (!relativeHome.startsWith("..") && !path.isAbsolute(relativeHome)) return `-${encode(relativeHome)}`;
  const relativeTmp = path.relative(tmp, resolved);
  if (relativeTmp === "") return "-tmp";
  if (!relativeTmp.startsWith("..") && !path.isAbsolute(relativeTmp)) return `-tmp-${encode(relativeTmp)}`;
  return `--${encode(resolved.replace(/^[/\\]/, ""))}--`;
}

function defaultOutputPath(target, cwd, sessionId, timestamp) {
  const stamp = timestamp.replace(/[:.]/g, "-");
  if (target === "pi") {
    return path.join(os.homedir(), ".pi", "agent", "sessions", encodePiSessionDir(cwd), `${stamp}_${sessionId}.jsonl`);
  }
  return path.join(os.homedir(), ".omp", "agent", "sessions", encodeOmpSessionDir(cwd), `${stamp}_${sessionId}.jsonl`);
}

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function commandFor(target, outputPath) {
  return target === "pi" ? `pi --session ${shellQuote(outputPath)}` : `omp --resume ${shellQuote(outputPath)}`;
}

function maybeOpen(target, outputPath) {
  const command = target === "pi" ? "pi" : "omp";
  const args = target === "pi" ? ["--session", outputPath] : ["--resume", outputPath];
  return spawnSync(command, args, { stdio: "inherit", env: process.env });
}

export function transfer(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const cwd = path.resolve(options.cwd || process.cwd());
  const source = resolveClaudeSource(cwd, options.source);
  const events = readJsonl(source);
  const converted = convertClaudeEvents(events, { ...options, source });
  const entries = buildTargetEntries(options.target, converted);
  const outputPath = options.output
    ? resolvePathFrom(cwd, options.output)
    : defaultOutputPath(options.target, converted.cwd, converted.header.id, converted.header.timestamp);
  writeJsonl(outputPath, entries);

  const result = {
    target: options.target,
    source,
    output: outputPath,
    cwd: converted.cwd,
    sessionId: converted.header.id,
    entries: entries.length,
    messages: converted.messages.length,
    command: commandFor(options.target, outputPath),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Wrote ${options.target.toUpperCase()} session JSONL: ${outputPath}\n`);
    process.stdout.write(`Source Claude transcript: ${source}\n`);
    process.stdout.write(`Session ID: ${converted.header.id}\n`);
    process.stdout.write(`Entries: ${entries.length} (${converted.messages.length} messages)\n`);
    process.stdout.write(`Resume command: ${result.command}\n`);
  }

  if (options.open) {
    const proc = maybeOpen(options.target, outputPath);
    if (proc.status && proc.status !== 0) process.exit(proc.status);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    transfer();
  } catch (error) {
    process.stderr.write(`session-transfer: ${error.message}\n`);
    process.exit(1);
  }
}
