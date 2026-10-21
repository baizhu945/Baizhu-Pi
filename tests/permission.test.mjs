import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const extensionPath = resolve(process.argv[2] ?? "extensions/permission/index.ts");
const { default: loadExtension } = await import(pathToFileURL(extensionPath));

const handlers = new Map();
const commands = new Map();
const prompts = [];
let nextChoice = "Allow";
let registeredTools = 0;
let sentMessages = 0;
const tools = [
  { name: "read", sourceInfo: { path: "builtin:read" } },
  { name: "bash", sourceInfo: { path: "builtin:bash" } },
  { name: "web_search", sourceInfo: { path: "/agent/extensions/pi-web-access/index.ts" } },
  { name: "annotated_read", annotations: { readOnlyHint: true }, sourceInfo: { path: "other.ts" } },
];
const pi = {
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, definition) => commands.set(name, definition),
  registerTool: () => registeredTools++,
  sendMessage: () => sentMessages++,
  getAllTools: () => tools,
};
const ctx = {
  mode: "rpc",
  hasUI: true,
  signal: undefined,
  ui: {
    notify() {},
    async select(title, options) {
      prompts.push({ title, options });
      return nextChoice;
    },
  },
};

loadExtension(pi);
const call = async (toolName, input = {}, toolCallId = "call") => handlers.get("tool_call")({ toolName, input, toolCallId }, ctx);
const command = async (args = "") => commands.get("permission").handler(args, ctx);

// Default-off behavior and direct passage for read-only tools.
assert.equal(await call("bash", { command: "echo hi" }), undefined);
assert.equal(prompts.length, 0);
assert.equal(await call("read", { path: "file.txt" }), undefined);
assert.equal(await call("web_search", { query: "Pi" }), undefined);
assert.equal(await call("annotated_read"), undefined);
assert.equal(prompts.length, 0);

// Record one real assistant batch and verify every sibling's exact arguments
// are present while the current call is individually identified.
handlers.get("message_end")({
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/home/baizhu945/.pi/agent/AGENTS.md", offset: 1, limit: 1 } },
      { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "pwd", timeout: 10 } },
      { type: "toolCall", id: "write-1", name: "write", arguments: { path: "/tmp/pi-tool-check.txt", content: "write tool check\n" } },
      { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "/tmp/pi-tool-check.txt", edits: [{ oldText: "write tool check\n", newText: "write and edit tool check\n" }] } },
    ],
  },
}, ctx);

// Enable review; Deny blocks execution, and the batch review shows all four calls.
await command("on");
nextChoice = "Deny";
const denied = await call("bash", { command: "pwd" }, "bash-1");
assert.deepEqual(denied, { block: true, reason: "The user denied this tool call; it was not executed." });
const batchTitle = prompts.at(-1).title;
assert.match(batchTitle, /2\/4/);
for (const visible of ["read", "AGENTS.md", "pwd", "write", "write tool check", "edit", "-1 write tool check", "+1 write and edit tool check"]) {
  assert.ok(batchTitle.includes(visible), `batch review omitted ${visible}`);
}
assert.deepEqual(prompts.at(-1).options, ["Allow", "Deny", "Always Allow"]);
nextChoice = "Allow";
const longContent = `${"x".repeat(1500)}FULL_CONTENT_END`;
assert.equal(await call("write", { path: "/tmp/pi-tool-check.txt", content: longContent }, "write-1"), undefined);
assert.ok(prompts.at(-1).title.includes("FULL_CONTENT_END"), "long write content was truncated");

// Always Allow covers subsequent calls for this session, without more prompts.
nextChoice = "Always Allow";
assert.equal(await call("edit", { path: "/tmp/pi-tool-check.txt", edits: [] }, "edit-1"), undefined);
const promptCount = prompts.length;
assert.equal(await call("write", { path: "file", content: "x" }), undefined);
assert.equal(prompts.length, promptCount);

// New/resumed/forked session state is reset to off; explicit off also bypasses review.
handlers.get("session_start")({}, ctx);
assert.equal(await call("bash"), undefined);
assert.equal(prompts.length, promptCount);
await command("on");
ctx.hasUI = false;
assert.deepEqual(await call("bash"), {
  block: true,
  reason: "User approval is unavailable; this tool call was not executed.",
});
ctx.hasUI = true;
await command("off");
assert.equal(await call("bash"), undefined);
assert.equal(prompts.length, promptCount);
assert.equal(registeredTools, 0);
assert.equal(sentMessages, 0);

console.log("permission extension tests passed");
