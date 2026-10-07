import { keyText, type KeybindingsManager, type SessionInfo, type SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildTree, expandSubtree, flatten, type Node, pathKey, type Row, search, type SortMode } from "./tree.ts";

export type Scope = "current" | "all";
export type Choice = { kind: "resume" | "rename" | "delete"; path: string; name?: string } | undefined;
// Pi publishes counts on every update, but session snapshots only periodically.
export type ListProgress = NonNullable<Parameters<typeof SessionManager.list>[2]>;
export type Loader = (scope: Scope, progress: ListProgress, signal: AbortSignal) => Promise<SessionInfo[]>;
export interface PickerState {
  scope: Scope;
  sort: SortMode;
  named: boolean;
  showPath: boolean;
  query: string;
  expanded: Set<string>;
  selected?: string;
}
export function newState(): PickerState {
  return { scope: "current", sort: "threaded", named: false, showPath: false, query: "", expanded: new Set() };
}

export class SessionPicker implements Component, Focusable {
  private input = new Input();
  private sessions: SessionInfo[] = [];
  private rows: Row[] = [];
  private nodes = new Map<string, Node>();
  private cache = new Map<Scope, SessionInfo[]>();
  private abort?: AbortController;
  private epoch = 0;
  private disposed = false;
  private loading = false;
  private status = "";
  private touched = false;
  private currentKey?: string;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(
    private state: PickerState,
    private loader: Loader,
    private theme: Theme,
    private kb: KeybindingsManager,
    private requestRender: () => void,
    private done: (choice: Choice) => void,
    currentPath?: string,
  ) {
    this.currentKey = currentPath ? pathKey(currentPath) : undefined;
    this.input.setValue(state.query);
    this.touched = !!state.selected;
    void this.load();
  }

  getSelectedPath(): string | undefined { return this.selectedRow()?.node.session.path; }
  getRows(): readonly Row[] { return this.rows; }

  private selectedRow(): Row | undefined {
    return this.rows.find(row => row.node.key === this.state.selected);
  }

  private rebuild(snapshot: SessionInfo[] = this.sessions): void {
    const sessions = this.state.named ? snapshot.filter(session => session.name?.trim()) : snapshot;
    const tree = buildTree(sessions);
    if (this.status.startsWith("Regex search")) this.status = "";
    let rows: Row[];
    try {
      rows = this.state.sort === "threaded" && !this.state.query.trim()
        ? flatten(tree.roots, this.state.expanded)
        : search(sessions, this.state.query, this.state.sort).map(session => ({ node: tree.nodes.get(pathKey(session.path))!, prefix: "" }));
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      rows = [];
    }
    let key = this.touched ? this.state.selected : undefined;
    const visible = new Set(rows.map(row => row.node.key));
    while (key && !visible.has(key)) key = tree.nodes.get(key)?.parent?.key;
    // Commit only after the entire new view has been built successfully.
    this.nodes = tree.nodes;
    this.rows = rows;
    this.state.selected = key ?? rows[0]?.node.key;
  }

  private updateSessions(sessions: readonly SessionInfo[]): void {
    if (!Array.isArray(sessions)) throw new TypeError("Session loader must return a session array");
    const snapshot = [...sessions];
    this.rebuild(snapshot);
    this.sessions = snapshot;
    this.requestRender();
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const abort = this.abort = new AbortController();
    const epoch = ++this.epoch;
    const scope = this.state.scope;
    this.loading = true;
    this.status = "Loading…";
    this.updateSessions(this.cache.get(scope) ?? []);
    let finished = false;
    const current = () => !finished && !this.disposed && this.epoch === epoch && !abort.signal.aborted;
    try {
      const sessions = await this.loader(scope, (loaded, total, partial) => {
        if (!current()) return;
        this.status = `Loading ${loaded}/${total}`;
        if (Array.isArray(partial)) this.updateSessions(partial);
        else this.requestRender(); // A count-only update must retain the last valid snapshot.
      }, abort.signal);
      if (!current()) return;
      this.loading = false;
      this.status = "";
      this.updateSessions(sessions);
      this.cache.set(scope, this.sessions);
      finished = true;
    } catch (error) {
      if (!current()) return;
      finished = true;
      abort.abort();
      this.loading = false;
      this.status = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
      this.requestRender();
    }
  }

  private choose(kind: NonNullable<Choice>["kind"]): void {
    const session = this.selectedRow()?.node.session;
    if (!session) return;
    if (kind === "delete" && pathKey(session.path) === this.currentKey) {
      this.status = "Cannot delete the currently active session";
      this.requestRender();
      return;
    }
    this.dispose();
    this.done({ kind, path: session.path, name: session.name });
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.touched = true;
    if (this.kb.matches(data, "tui.select.cancel")) { this.dispose(); this.done(undefined); return; }
    if (this.kb.matches(data, "tui.input.tab")) {
      this.state.scope = this.state.scope === "current" ? "all" : "current";
      void this.load();
      return;
    }
    if (this.kb.matches(data, "app.session.toggleSort")) {
      this.state.sort = this.state.sort === "threaded" ? "recent" : this.state.sort === "recent" ? "fuzzy" : "threaded";
    } else if (this.kb.matches(data, "app.session.toggleNamedFilter")) {
      this.state.named = !this.state.named;
    } else if (this.kb.matches(data, "app.session.togglePath")) {
      this.state.showPath = !this.state.showPath;
    } else if (this.kb.matches(data, "app.session.rename")) {
      this.choose("rename"); return;
    } else if (this.kb.matches(data, "app.session.delete") || (!this.state.query && this.kb.matches(data, "app.session.deleteNoninvasive"))) {
      this.choose("delete"); return;
    } else if (this.kb.matches(data, "tui.select.confirm")) {
      this.choose("resume"); return;
    } else if (this.state.sort === "threaded" && !this.state.query.trim() && (matchesKey(data, "left") || matchesKey(data, "right"))) {
      const expand = matchesKey(data, "right");
      let node = this.selectedRow()?.node;
      if (!expand && node && (!node.children.length || !this.state.expanded.has(node.key))) node = node.parent;
      if (node?.children.length) {
        expandSubtree(node, this.state.expanded, expand);
        this.state.selected = node.key;
      }
    } else {
      const index = Math.max(0, this.rows.findIndex(row => row.node.key === this.state.selected));
      let step = 0;
      if (this.kb.matches(data, "tui.select.up")) step = -1;
      else if (this.kb.matches(data, "tui.select.down")) step = 1;
      else if (this.kb.matches(data, "tui.select.pageUp")) step = -10;
      else if (this.kb.matches(data, "tui.select.pageDown")) step = 10;
      if (step) this.state.selected = this.rows[Math.max(0, Math.min(this.rows.length - 1, index + step))]?.node.key;
      else {
        this.input.handleInput(data);
        this.state.query = this.input.getValue();
      }
    }
    this.rebuild();
    this.requestRender();
  }

  render(width: number): string[] {
    width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const lines = [
      this.theme.bold(`Resume Session (${this.state.scope === "current" ? "Current Folder" : "All"})`),
      this.theme.fg("muted", `← collapse · → expand · ${keyText("tui.input.tab")} scope · ${keyText("app.session.toggleSort")} sort: ${this.state.sort} · ${keyText("app.session.toggleNamedFilter")} ${this.state.named ? "named" : "all"}`),
      ...this.input.render(width),
      "",
    ];
    const index = Math.max(0, this.rows.findIndex(row => row.node.key === this.state.selected));
    const start = Math.max(0, Math.min(index - 5, this.rows.length - 10));
    for (const row of this.rows.slice(start, start + 10)) {
      const { session } = row.node;
      const selected = row.node.key === this.state.selected;
      const text = (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f]/g, " ").trim();
      const age = Math.max(0, Math.floor((Date.now() - session.modified.getTime()) / 60000));
      const ageText = age < 1 ? "now" : age < 60 ? `${age}m` : age < 1440 ? `${Math.floor(age / 60)}h` : `${Math.floor(age / 1440)}d`;
      const right = [this.state.showPath ? session.path : "", this.state.scope === "all" ? session.cwd : "", session.messageCount, ageText].filter(value => value !== "").join(" ");
      const prefix = (selected ? this.theme.fg("accent", "› ") : "  ") + this.theme.fg("dim", row.prefix);
      const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(right) - 2);
      let label = this.theme.fg(row.node.key === this.currentKey ? "accent" : session.name ? "warning" : "text", truncateToWidth(text, budget, "…"));
      if (selected) label = this.theme.bold(label);
      let line = prefix + label;
      line += " ".repeat(Math.max(1, width - visibleWidth(line) - visibleWidth(right))) + this.theme.fg("dim", right);
      if (selected) line = this.theme.bg("selectedBg", line);
      lines.push(line);
    }
    if (!this.rows.length && !this.loading) lines.push(this.theme.fg("muted", "No matching sessions"));
    lines.push(this.theme.fg("muted", `(${this.rows.length ? index + 1 : 0}/${this.rows.length}) ${keyText("tui.select.confirm")} resume · ${keyText("tui.select.cancel")} cancel · ${keyText("app.session.rename")} rename · ${keyText("app.session.delete")} delete · ${keyText("app.session.togglePath")} path`));
    if (this.status) lines.push(this.theme.fg(this.loading ? "muted" : "error", this.status));
    return lines.map(line => truncateToWidth(line, width, "…"));
  }

  invalidate(): void { this.input.invalidate(); }
  dispose(): void { this.disposed = true; this.abort?.abort(); }
}
