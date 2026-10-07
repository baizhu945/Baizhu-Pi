import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SidekickViewer, readSidekickHistory, VIEWER_MAX_MESSAGES, VIEWER_REFRESH_MS } from "../src/sidekick-viewer.js";
import { SidekickRuntime } from "../src/sidekick-runtime.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2, stopReason: "stop" });
function fixture(messages: any[] = []) {
  const directory = mkdtempSync("/tmp/fusion-viewer-");
  const sessionFile = join(directory, "sidekick.jsonl");
  const entries = [{ type: "session", version: 3, id: "test-session", timestamp: "2026-10-04T00:00:00Z", cwd: directory },
    ...messages.map((message, index) => ({ type: "message", id: `m${index}`, parentId: index ? `m${index - 1}` : null, timestamp: "2026-10-04T00:00:00Z", message }))];
  writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const child: any = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("close"); return true; };
  const sent: any[] = [];
  child.stdin.on("data", (chunk: Buffer) => { for (const line of String(chunk).trim().split("\n")) if (line) sent.push(JSON.parse(line)); });
  let renders = 0, closed = 0, stops = 0;
  const forwarded: string[] = [];
  const runtime = new SidekickRuntime({ cwd: directory, sessionFile, model: "test/side", thinking: "low", systemPrompt: "test", spawn: (() => child) as never, command: { command: "fake", args: [] } });
  const options: any = { runtime, name: "Sidekick 测试😀", thinking: "low", theme, tui: { terminal: { rows: 40 }, requestRender() { renders++; } },
    done() { closed++; }, onSend(message: string) { forwarded.push(message); runtime.handoff(message); }, onStop() { stops++; } };
  const viewer = new SidekickViewer(options);
  const wire = (event: any) => child.stdout.write(JSON.stringify(event) + "\n");
  return { viewer, runtime, child, options, sent, forwarded, wire, sessionFile,
    text: (width = 100) => viewer.render(width).map(stripTerminalSequences).join("\n"),
    closed: () => closed, stops: () => stops, renders: () => renders,
    close() { viewer.dispose(); runtime.kill(); } };
}

test("history uses the active branch, skips a partial journal tail and never rewrites a file", () => {
  const f = fixture([user("original"), assistant("old branch")]);
  try {
    const branch = { type: "message", id: "new", parentId: "m0", timestamp: "2026-10-04T00:00:01Z", message: assistant("active branch") };
    writeFileSync(f.sessionFile, readFileSync(f.sessionFile, "utf8") + JSON.stringify(branch) + '\n{"type":"message",');
    const before = readFileSync(f.sessionFile);
    assert.deepEqual(readSidekickHistory(f.sessionFile).map((message: any) => message.content[0].text), ["original", "active branch"]);
    assert.deepEqual(readFileSync(f.sessionFile), before);
    writeFileSync(f.sessionFile, "");
    assert.deepEqual(readSidekickHistory(f.sessionFile), []);
    assert.equal(readFileSync(f.sessionFile, "utf8"), "");
    assert.deepEqual(readSidekickHistory(join(dirname(f.sessionFile), "missing")), []);
  } finally { f.close(); }
});

test("viewer renders live thinking, tool arguments, output and errors from the existing child", () => {
  const f = fixture([user("brief"), assistant("analysis")]);
  try {
    f.runtime.handoff("brief");
    f.wire({ type: "message_update", message: { ...assistant(""), content: [{ type: "thinking", thinking: "inspect the source" }] }, assistantMessageEvent: { type: "thinking_delta", delta: "inspect the source" } });
    assert.match(f.text(), /thinking.*\n.*inspect the source/s);
    f.wire({ type: "message_end", message: { ...assistant(""), content: [{ type: "toolCall", name: "read", arguments: { path: "source.ts" } }] } });
    f.wire({ type: "message_start", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file output" }], isError: true } });
    assert.match(f.text(), /tool: read/);
    assert.match(f.text(), /source\.ts/);
    assert.match(f.text(), /file output/);
    f.wire({ type: "tool_execution_start", toolCallId: "live-tool", toolName: "bash", args: { command: "printf progress" } });
    f.wire({ type: "tool_execution_update", toolCallId: "live-tool", partialResult: { content: [{ type: "text", text: "live progress output" }] } });
    assert.match(f.text(), /tool running: bash/);
    assert.match(f.text(), /live progress output/);
    f.wire({ type: "tool_execution_end", toolCallId: "live-tool", result: { content: [{ type: "text", text: "done" }] } });
    assert.doesNotMatch(f.text(), /tool running: bash/);
    f.wire({ type: "message_end", message: { ...assistant(""), stopReason: "error", errorMessage: "Upstream timeout" } });
    assert.match(f.text(), /Upstream timeout/);
  } finally { f.close(); }
});

test("opening during a stream immediately includes the current response", () => {
  const f = fixture();
  let second: SidekickViewer | undefined;
  try {
    f.runtime.handoff("brief");
    f.wire({ type: "message_update", message: assistant("already streaming") });
    second = new SidekickViewer(f.options);
    assert.match(second.render(100).join("\n"), /already streaming/);
  } finally { second?.dispose(); f.close(); }
});

test("Enter sends steering to the same handoff; Esc closes only the inspector", () => {
  const f = fixture();
  try {
    const handoff = f.runtime.handoff("brief");
    for (const input of ["\r", "Please verify first", "\r"]) f.viewer.handleInput(input);
    assert.deepEqual(f.forwarded, ["Please verify first"]);
    assert.equal(f.runtime.latest()?.id, handoff.id);
    assert.equal(f.sent.at(-1).streamingBehavior, "steer");
    assert.equal(f.sent.at(-1).message, "Please verify first");
    f.viewer.handleInput("\x1b");
    assert.equal(f.closed(), 1);
    assert.equal(f.child.killed, false);
    assert.equal(f.runtime.isBusy(), true);
    f.viewer.close();
    assert.equal(f.closed(), 1);
  } finally { f.close(); }
});

test("Esc cancels composing; failed sends preserve the draft and show the real error", () => {
  const f = fixture();
  try {
    for (const input of ["\r", "cancelled", "\x1b"]) f.viewer.handleInput(input);
    assert.deepEqual(f.forwarded, []);
    assert.equal(f.closed(), 0);
    f.options.onSend = () => { throw new Error("inactive branch"); };
    for (const input of ["\r", "keep draft", "\r"]) f.viewer.handleInput(input);
    assert.match(f.text(), /inactive branch/);
    assert.match(f.text(), /keep draft/);
    assert.match(f.text(), /Enter send/);
  } finally { f.close(); }
});

test("scroll holds position during updates; End follows; x requires confirmation", () => {
  const f = fixture(Array.from({ length: 50 }, (_, index) => user(`line-${index}`)));
  try {
    f.runtime.handoff("brief");
    f.viewer.render(100);
    f.viewer.handleInput("\x1b[H");
    assert.match(f.text(), /line-0/);
    f.wire({ type: "message_end", message: assistant("newest") });
    assert.match(f.text(), /line-0/);
    assert.doesNotMatch(f.text(), /newest/);
    f.viewer.handleInput("\x1b[F");
    assert.match(f.text(), /newest/);
    f.viewer.handleInput("x");
    assert.equal(f.stops(), 0);
    f.viewer.handleInput("j");
    f.viewer.handleInput("x");
    assert.equal(f.stops(), 0);
    f.viewer.handleInput("x");
    assert.equal(f.stops(), 1);
  } finally { f.close(); }
});

test("history windows, terminal sequences, CJK widths and resizing stay bounded", () => {
  const f = fixture(Array.from({ length: VIEWER_MAX_MESSAGES + 2 }, (_, index) => user(`条目😀-${index}\x1b[2J\x1b]0;bad-title\x07${index === VIEWER_MAX_MESSAGES + 1 ? "source".repeat(3000) : "source"}`)));
  try {
    assert.match(f.text(), /display truncated/);
    f.viewer.handleInput("\x1b[H");
    assert.match(f.text(180), /2 earlier messages omitted/);
    for (const width of [1, 2, 8, 12, 20, 80, 120, 30]) {
      const lines = f.viewer.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
      assert.ok(lines.length <= 28);
      assert.doesNotMatch(lines.join("\n"), /bad-title|\x1b\[2J/);
    }
  } finally { f.close(); }
});

test("closing releases timers/subscriptions and leaves sidekick work running", async () => {
  const f = fixture();
  try {
    f.runtime.handoff("brief");
    f.viewer.close();
    const renders = f.renders();
    f.wire({ type: "message_update", message: assistant("after close") });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.renders(), renders);
    assert.equal(f.runtime.isBusy(), true);
  } finally { f.close(); }
});

test("a child failure preserves partial evidence and stops claiming that work is live", () => {
  const f = fixture();
  try {
    f.runtime.handoff("brief");
    f.wire({ type: "tool_execution_start", toolCallId: "unfinished", toolName: "bash", args: {} });
    f.wire({ type: "message_update", message: assistant("partial evidence") });
    assert.match(f.text(), /streaming/);
    f.child.emit("close", 1, "SIGKILL");
    assert.match(f.text(), /partial evidence/);
    assert.match(f.text(), /assistant · partial/);
    assert.match(f.text(), /tool interrupted: bash/);
    assert.match(f.text(), /Sidekick process exited/);
    assert.doesNotMatch(f.text(), /tool running|streaming/);
  } finally { f.close(); }
});

test("stream bursts request one render per throttle window and idle viewers stop polling", async () => {
  const f = fixture();
  try {
    f.runtime.handoff("brief");
    for (let i = 0; i < 100; i++) f.wire({ type: "message_update", message: assistant(`latest-${i}`) });
    await new Promise(resolve => setTimeout(resolve, VIEWER_REFRESH_MS + 40));
    assert.equal(f.renders(), 1);
    assert.match(f.text(), /latest-99/);
    f.child.emit("close", 1, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, VIEWER_REFRESH_MS + 40));
    const renders = f.renders();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(f.renders(), renders, "idle/error heartbeat does not refresh the entire main transcript");
  } finally { f.close(); }
});
