import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { transfer } from "../scripts/session-transfer.mjs";

const fixture = path.resolve(import.meta.dirname, "fixtures", "claude-session.jsonl");
const piSessionManagerPath = process.env.PI_SESSION_MANAGER_PATH
  || "/Volumes/ExtSSD/Caches/mise/installs/npm-earendil-works-pi-coding-agent/latest/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
const ompBin = process.env.OMP_BIN || "/Volumes/ExtSSD/Caches/mise/installs/github-can1357-oh-my-pi/16.3.4/omp";


function readJsonl(file) {
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

function tempOutput(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "session-transfer-")), name);
}

test("converts Claude transcript into Pi v3 JSONL", () => {
  const output = tempOutput("pi.jsonl");
  const result = transfer(["pi", "--source", fixture, "--output", output, "--json"]);
  assert.equal(result.target, "pi");
  assert.equal(result.output, output);

  const entries = readJsonl(output);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[0].version, 3);
  assert.equal(entries[1].type, "model_change");
  assert.equal(entries[1].provider, "anthropic");
  assert.equal(entries[1].modelId, "claude-sonnet-4-5");

  const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, "user");
  assert.deepEqual(messages[1].content[1], {
    type: "toolCall",
    id: "toolu_read_1",
    name: "Read",
    arguments: { path: "package.json" },
  });
  assert.equal(messages[1].stopReason, "toolUse");
  assert.equal(messages[2].role, "toolResult");
  assert.equal(messages[2].toolCallId, "toolu_read_1");
  assert.equal(messages[2].toolName, "Read");
  assert.equal(messages[3].content[0].type, "thinking");
});

test("converts Claude transcript into OMP v3 JSONL", () => {
  const output = tempOutput("omp.jsonl");
  const result = transfer(["omp", "--source", fixture, "--output", output, "--json"]);
  assert.equal(result.target, "omp");

  const entries = readJsonl(output);
  assert.equal(entries[1].type, "model_change");
  assert.equal(entries[1].model, "anthropic/claude-sonnet-4-5");
  assert.equal(entries[1].role, "default");
  assert.match(result.command, /^omp --resume /);

  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i].parentId, i === 1 ? null : entries[i - 1].id);
  }
});

test("accepts Claude command single-string arguments", () => {
  const output = tempOutput("quoted pi.jsonl");
  const result = transfer(["pi", `--source "${fixture}" --output "${output}" --json`]);
  assert.equal(result.target, "pi");
  assert.equal(result.output, output);
  assert.equal(readJsonl(output)[0].type, "session");
});

test("generated Pi session loads through Pi SessionManager", async () => {
  const output = tempOutput("pi-load.jsonl");
  transfer(["pi", "--source", fixture, "--output", output, "--json"]);

  const { SessionManager } = await import(`file://${piSessionManagerPath}`);
  const manager = SessionManager.open(output, path.dirname(output));
  const context = manager.buildSessionContext();
  assert.equal(context.messages.length, 4);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[1].role, "assistant");
  assert.equal(context.messages[2].role, "toolResult");
});

test("generated OMP session loads through OMP export fast path", () => {
  const output = tempOutput("omp-load.jsonl");
  const html = tempOutput("omp-load.html");
  transfer(["omp", "--source", fixture, "--output", output, "--json"]);

  const result = spawnSync(ompBin, ["--export", output, html], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(html), "OMP export did not write HTML output");
  assert.match(fs.readFileSync(html, "utf8"), /<title>Session Export<\/title>/);
});
