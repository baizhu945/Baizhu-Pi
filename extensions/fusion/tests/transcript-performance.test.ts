import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { registerFusionTools } from "../src/tools.js";
import { renderSidekickTranscript, TRANSCRIPT_MAX_CHARS, TRANSCRIPT_MAX_LINES, EXPANDED_TRANSCRIPT_WINDOW } from "../src/transcript.js";
import type { SidekickEvent } from "../src/sidekick-runtime.js";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const textEvents = (count: number): SidekickEvent[] => Array.from({ length: count }, (_, i) => ({ kind: "text", text: `step-${i} **${"中文source ".repeat(800)}**`, open: false }));

test("expanded previews bound parsing and terminal lines at the RPC retention limit", () => {
  const events = textEvents(300);
  let parsedChars = 0, created = 0;
  const transcript = renderSidekickTranscript(theme, { events, header: "working", expanded: true, isPartial: true,
    renderText: text => { parsedChars += text.length; created++; return new Text(text, 0, 0); } });
  for (const width of [120, 1, 20]) {
    const lines = transcript.render(width);
    assert.ok(lines.length <= TRANSCRIPT_MAX_LINES);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width === 120) assert.match(lines.join("\n"), /history/);
  }
  assert.ok(parsedChars <= TRANSCRIPT_MAX_CHARS);
  assert.ok(created <= EXPANDED_TRANSCRIPT_WINDOW);
  assert.equal(events.length, 300, "display limits do not modify the report/session");
});

test("unchanged frames reuse the same lines; fresh RPC snapshots rebuild only changed events", () => {
  const events: SidekickEvent[] = Array.from({ length: 20 }, (_, i) => ({ kind: "text", text: `step-${i}`, open: false }));
  let created = 0;
  const renderText = (text: string) => { created++; return new Text(text, 0, 0); };
  const options = { events, header: "working", expanded: true, isPartial: true, renderText };
  const transcript = renderSidekickTranscript(theme, options);
  const first = transcript.render(120);
  for (let i = 0; i < 50; i++) assert.equal(transcript.render(120), first);
  assert.equal(created, 20);
  transcript.update({ ...options, header: "working 2s", events: events.map(event => ({ ...event })) });
  transcript.render(120);
  assert.equal(created, 20);
  (events.at(-1) as Extract<SidekickEvent, { kind: "text" }>).text = "new text";
  transcript.update({ ...options, events: events.map(event => ({ ...event })) });
  assert.match(transcript.render(120).join("\n"), /new text/);
  assert.equal(created, 21);
  transcript.invalidate();
  transcript.render(120);
  assert.equal(created, 41, "theme invalidation refreshes the text renderers");
});

test("SDK renderer context keeps one framed component across progress snapshots and toggles", () => {
  const tools = new Map<string, { renderResult: (...args: any[]) => any }>();
  registerFusionTools({ registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer() {}, on() {} } as any, { getRuntime: () => undefined });
  for (const name of ["sidekick", "read_subagent"]) {
    const renderer = tools.get(name)!.renderResult;
    const context = { state: {} };
    const progress = { toolCalls: 0, recentTools: [], textTail: "", startedAt: Date.now(), events: textEvents(300), droppedEvents: 0 };
    const result = { content: [], details: { progress } };
    const first = renderer(result, { expanded: false }, theme, context);
    first.render(120);
    const expanded = renderer(result, { expanded: true }, theme, context);
    assert.equal(expanded, first);
    const lines = expanded.render(120);
    for (let i = 0; i < 50; i++) assert.equal(expanded.render(120), lines);
    assert.ok(lines.length <= TRANSCRIPT_MAX_LINES);
  }
});

test("line-budget warnings survive and the final report is still shown", () => {
  const transcript = renderSidekickTranscript(theme, { events: [{ kind: "text", text: "old\n".repeat(4000), open: false }],
    header: "completed", expanded: true, isPartial: false, report: { text: "FINAL REPORT" }, renderText: text => new Text(text, 0, 0) });
  const lines = transcript.render(40);
  assert.ok(lines.length <= TRANSCRIPT_MAX_LINES);
  assert.match(lines.join("\n"), /display lines omitted/);
  assert.match(lines.join("\n"), /FINAL REPORT/);
});
