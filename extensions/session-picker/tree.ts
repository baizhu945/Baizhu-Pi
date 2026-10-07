import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export type SortMode = "threaded" | "recent" | "fuzzy";
export interface Node {
  session: SessionInfo;
  key: string;
  parent?: Node;
  children: Node[];
  activity: number;
}
export interface Row {
  node: Node;
  prefix: string;
}

// A user-entered regex can catastrophically backtrack over saved transcripts.
// Keep the existing regex syntax but bound its synchronous execution time.
const regexSearch = new Script("const pattern = new RegExp(query, 'i'); texts.map(text => pattern.test(text))");

export function pathKey(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function buildTree(sessions: SessionInfo[]): { roots: Node[]; nodes: Map<string, Node> } {
  const paths = new Map<string, string>();
  const keyFor = (path: string) => {
    let key = paths.get(path);
    if (key === undefined) { key = pathKey(path); paths.set(path, key); }
    return key;
  };
  const nodes = new Map<string, Node>();
  for (const session of sessions) {
    const key = keyFor(session.path);
    if (!nodes.has(key)) nodes.set(key, { session, key, children: [], activity: session.modified.getTime() });
  }
  const roots: Node[] = [];
  const parents = new Map<string, Node | undefined>();
  const valid = new Map<string, boolean>();
  for (const node of nodes.values()) parents.set(node.key, node.session.parentSessionPath ? nodes.get(keyFor(node.session.parentSessionPath)) : undefined);
  for (const node of nodes.values()) {
    if (!valid.has(node.key)) {
      const chain: Node[] = [];
      const seen = new Set<string>();
      let current: Node | undefined = node;
      while (current && !valid.has(current.key) && !seen.has(current.key)) {
        chain.push(current);
        seen.add(current.key);
        current = parents.get(current.key);
      }
      const acyclic = current === undefined || valid.get(current.key) === true;
      for (const entry of chain) valid.set(entry.key, acyclic);
    }
    const parent = parents.get(node.key);
    if (parent && valid.get(node.key)) { node.parent = parent; parent.children.push(node); }
    else roots.push(node);
  }
  const pending = roots.map(node => ({ node, visited: false }));
  while (pending.length) {
    const { node, visited } = pending.pop()!;
    if (!visited) {
      pending.push({ node, visited: true });
      for (const child of node.children) pending.push({ node: child, visited: false });
    } else {
      for (const child of node.children) node.activity = Math.max(node.activity, child.activity);
      node.children.sort((a, b) => b.activity - a.activity);
    }
  }
  roots.sort((a, b) => b.activity - a.activity);
  return { roots, nodes };
}

export function flatten(roots: Node[], expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const pending = roots.map((node, i) => ({ node, continuation: [] as boolean[], last: i === roots.length - 1, root: true, deep: false })).reverse();
  while (pending.length) {
    const { node, continuation, last, root, deep } = pending.pop()!;
    const disclosure = node.children.length ? (expanded.has(node.key) ? "▾ " : "▸ ") : "";
    const branch = root ? "" : (deep ? "…  " : "") + continuation.map((more) => more ? "│  " : "   ").join("") + (last ? "└─ " : "├─ ");
    rows.push({ node, prefix: branch + disclosure });
    if (expanded.has(node.key)) {
      const next = root ? [] : [...continuation, !last];
      for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i]!, continuation: next.slice(-32), last: i === node.children.length - 1, root: false, deep: deep || next.length > 32 });
    }
  }
  return rows;
}

export function expandSubtree(node: Node, expanded: Set<string>, open: boolean): void {
  const pending = [node];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    if (open) expanded.add(current.key); else expanded.delete(current.key);
    pending.push(...current.children);
  }
}

export function search(sessions: SessionInfo[], query: string, sort: SortMode): SessionInfo[] {
  const text = (session: SessionInfo) => [session.id, session.name, session.cwd, session.firstMessage, session.allMessagesText].filter(Boolean).join(" ").replace(/\s+/g, " ");
  const trimmed = query.trim();
  if (!trimmed) return [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  if (trimmed.startsWith("re:")) {
    try {
      const matches = regexSearch.runInNewContext({ query: trimmed.slice(3), texts: sessions.map(text) }, { timeout: 100 }) as boolean[];
      return sessions.filter((_session, i) => matches[i]);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new Error("Regex search exceeded 100 ms; simplify the expression");
      return [];
    }
  }
  const phrases: string[] = [];
  const fuzzy = trimmed.replace(/"([^"]*)"/g, (_match, phrase: string) => { phrases.push(phrase.toLowerCase().replace(/\s+/g, " ")); return " "; }).trim();
  const candidates = sessions.filter(session => phrases.every(phrase => text(session).toLowerCase().includes(phrase)));
  const matches = fuzzy ? fuzzyFilter(candidates, fuzzy, text) : candidates;
  if (sort !== "recent") return matches;
  const keys = new Set(matches.map(session => session.path));
  return candidates.filter(session => keys.has(session.path)).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
