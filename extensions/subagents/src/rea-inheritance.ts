/**
 * Parent prompt inheritance is a string boundary (not the parent's structured
 * prompt state). Do not infer authorization from tool names or the word "rea".
 * Only the controller's explicit mode section enables this narrow transform.
 * Never apply it to task text or inherited conversation messages.
 */
const MODE_MARKER = "REA mode is explicitly authorized for this session. Use mcp__rea__ tools for reverse engineering.";
const TOOLS_FOOTER = "In addition to the tools above, you may have access to other custom tools depending on the project.";

interface Line { start: number; end: number; text: string; }
interface Section { name: string; start: number; end: number; bodyStart: number; bodyEnd: number; }
interface Change { start: number; end: number; text: string; }

function lines(text: string): Line[] {
  const result: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    result.push({ start, end, text: text.slice(start, end).replace(/\r?\n$/, "") });
    start = end;
  }
  return result;
}

/** Fenced examples are data, not prompt section/entry delimiters. */
function fenceEnd(line: string, fence: string | undefined): string | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return fence;
  if (!fence) return match[1];
  return match[1][0] === fence[0] && match[1].length >= fence.length &&
    /^ {0,3}(?:`+|~+)\s*$/.test(line) ? undefined : fence;
}

/**
 * Read Pi's top-level <section> framing without XML-normalizing any bytes.
 * Other sections (project context, goals, Fusion, etc.) are opaque: tags in
 * their user-authored contents are not interpreted as controller sections.
 * Matching same-name tags are balanced, including nested/inline tags; unlike
 * a non-greedy whole-prompt regex, a nested </rea> cannot end the outer block.
 * Incomplete framing is left untouched, never consumed through EOF.
 */
function sections(prompt: string): Section[] {
  const source = lines(prompt);
  const result: Section[] = [];
  let fence: string | undefined;
  for (let i = 0; i < source.length; i++) {
    const line = source[i];
    const nextFence = fenceEnd(line.text, fence);
    if (fence || nextFence) { fence = nextFence; continue; }
    const open = /^<([a-z][a-z0-9_-]*)(?:\s+[^<>]*)?>[ \t]*$/.exec(line.text);
    if (!open || /\/\s*>/.test(line.text)) continue;
    const name = open[1];
    const tag = new RegExp(`<(/?)${name}(?:\\s+[^<>]*?)?>`, "g");
    let depth = 1;
    let innerFence: string | undefined;
    let found = false;
    for (let j = i + 1; j < source.length; j++) {
      const inner = source[j];
      const nextInnerFence = fenceEnd(inner.text, innerFence);
      if (innerFence || nextInnerFence) { innerFence = nextInnerFence; continue; }
      tag.lastIndex = 0;
      for (const match of inner.text.matchAll(tag)) {
        if (/\/\s*>$/.test(match[0])) continue;
        depth += match[1] ? -1 : 1;
        if (depth !== 0) continue;
        const bodyEnd = inner.start + match.index!;
        result.push({ name, start: line.start, end: bodyEnd + match[0].length, bodyStart: line.end, bodyEnd });
        i = j;
        found = true;
        break;
      }
      if (found) break;
    }
    // A malformed outer section is opaque too, rather than making its contents
    // eligible for accidental removal as top-level controller instructions.
    if (!found) break;
  }
  return result;
}

function apply(text: string, changes: Change[]): string {
  let result = "";
  let cursor = 0;
  for (const change of changes.sort((a, b) => a.start - b.start)) {
    result += text.slice(cursor, change.start) + change.text;
    cursor = change.end;
  }
  return result + text.slice(cursor);
}

/** Remove whole SDK list entries, including their multiline continuations. */
function withoutEntries(body: string, kind: "tools" | "mcp_servers"): string {
  const entries: { start: number; name: string }[] = [];
  let fence: string | undefined;
  let listEnd = body.length;
  for (const line of lines(body)) {
    const nextFence = fenceEnd(line.text, fence);
    if (fence || nextFence) { fence = nextFence; continue; }
    if (kind === "tools" && line.text === TOOLS_FOOTER) {
      // This footer is not a continuation of the final tool's description.
      // Preserve its separating blank lines byte-for-byte as well.
      listEnd = line.start;
      if (body[listEnd - 1] === "\n") listEnd -= body[listEnd - 2] === "\r" ? 2 : 1;
      break;
    }
    const entry = kind === "tools"
      ? /^- ([A-Za-z0-9_]+):(?:\s|$)/.exec(line.text)
      : /^- (mcp__[A-Za-z0-9_-]+) \((?:codemode|tool_search)\)(?::|\s*$)/.exec(line.text);
    if (entry) entries.push({ start: line.start, name: entry[1] });
  }
  const changes: Change[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const owned = kind === "tools" ? entry.name.startsWith("mcp__rea__") : entry.name === "mcp__rea";
    if (owned) changes.push({ start: entry.start, end: entries[i + 1]?.start ?? listEnd, text: "" });
  }
  return changes.length ? apply(body, changes) : body;
}

export function sanitizeReaParentPrompt(prompt: string): string {
  // Cold parents retain exactly the same cacheable bytes, even if their own
  // code/docs happen to mention REA tools or an unrelated <rea> tag.
  if (!prompt.includes(MODE_MARKER)) return prompt;
  const parsed = sections(prompt);
  const owned = parsed.filter((section) => section.name === "rea" &&
    prompt.slice(section.bodyStart, section.bodyEnd).split(/\r?\n/, 1)[0] === MODE_MARKER);
  if (!owned.length) return prompt;
  const changes: Change[] = owned.map(({ start, end }) => ({ start, end, text: "" }));
  for (const section of parsed) {
    if (section.name !== "tools" && section.name !== "mcp_servers") continue;
    const body = prompt.slice(section.bodyStart, section.bodyEnd);
    const cleaned = withoutEntries(body, section.name);
    if (cleaned !== body) changes.push({ start: section.bodyStart, end: section.bodyEnd, text: cleaned });
  }
  return apply(prompt, changes);
}
