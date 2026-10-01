import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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

export function pathKey(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function buildTree(sessions: SessionInfo[]): { roots: Node[]; nodes: Map<string, Node> } {
  const nodes = new Map<string, Node>();
  for (const session of sessions) {
    const key = pathKey(session.path);
    if (!nodes.has(key)) nodes.set(key, { session, key, children: [], activity: session.modified.getTime() });
  }
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.session.parentSessionPath ? nodes.get(pathKey(node.session.parentSessionPath)) : undefined;
    // Corrupt/cyclic headers must not hide sessions or recurse indefinitely.
    const seen = new Set([node.key]);
    let ancestor = parent;
    let cycle = false;
    while (ancestor) {
      if (seen.has(ancestor.key)) { cycle = true; break; }
      seen.add(ancestor.key);
      ancestor = ancestor.session.parentSessionPath ? nodes.get(pathKey(ancestor.session.parentSessionPath)) : undefined;
    }
    if (parent && !cycle) { node.parent = parent; parent.children.push(node); }
    else roots.push(node);
  }
  const sort = (items: Node[]): number => {
    let latest = 0;
    for (const node of items) {
      node.activity = Math.max(node.activity, sort(node.children));
      latest = Math.max(latest, node.activity);
    }
    items.sort((a, b) => b.activity - a.activity);
    return latest;
  };
  sort(roots);
  return { roots, nodes };
}

export function flatten(roots: Node[], expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (node: Node, continuation: boolean[], last: boolean, root: boolean): void => {
    const disclosure = node.children.length ? (expanded.has(node.key) ? "▾ " : "▸ ") : "";
    const branch = root ? "" : continuation.map((more) => more ? "│  " : "   ").join("") + (last ? "└─ " : "├─ ");
    rows.push({ node, prefix: branch + disclosure });
    if (expanded.has(node.key)) {
      node.children.forEach((child, i) => walk(child, root ? [] : [...continuation, !last], i === node.children.length - 1, false));
    }
  };
  roots.forEach((node, i) => walk(node, [], i === roots.length - 1, true));
  return rows;
}

export function expandSubtree(node: Node, expanded: Set<string>, open: boolean): void {
  if (open) expanded.add(node.key); else expanded.delete(node.key);
  for (const child of node.children) expandSubtree(child, expanded, open);
}

export function search(sessions: SessionInfo[], query: string, sort: SortMode): SessionInfo[] {
  const text = (session: SessionInfo) => [session.id, session.name, session.cwd, session.firstMessage, session.allMessagesText].filter(Boolean).join(" ").replace(/\s+/g, " ");
  const trimmed = query.trim();
  if (!trimmed) return [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  if (trimmed.startsWith("re:")) {
    try { const regex = new RegExp(trimmed.slice(3), "i"); return sessions.filter(session => regex.test(text(session))); }
    catch { return []; }
  }
  const phrases: string[] = [];
  const fuzzy = trimmed.replace(/"([^"]*)"/g, (_match, phrase: string) => { phrases.push(phrase.toLowerCase().replace(/\s+/g, " ")); return " "; }).trim();
  const candidates = sessions.filter(session => phrases.every(phrase => text(session).toLowerCase().includes(phrase)));
  const matches = fuzzy ? fuzzyFilter(candidates, fuzzy, text) : candidates;
  if (sort !== "recent") return matches;
  const keys = new Set(matches.map(session => session.path));
  return candidates.filter(session => keys.has(session.path)).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
