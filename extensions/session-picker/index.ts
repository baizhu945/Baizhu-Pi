import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { routeFocusedEditor, type SubmitRoutes } from "./editor.ts";
import { type Choice, type Loader, newState, SessionPicker } from "./picker.ts";
import { pathKey } from "./tree.ts";

export function sessionLoader(ctx: ExtensionContext): Loader {
  const cwd = ctx.sessionManager.getCwd();
  const dir = ctx.sessionManager.getSessionDir();
  // Obtain the default from the public API, without copying Pi's path encoding.
  const defaultDir = SessionManager.inMemory(cwd).getSessionDir();
  return (scope, progress, signal) => scope === "current"
    ? SessionManager.list(cwd, dir, progress, signal)
    : pathKey(dir) === pathKey(defaultDir)
      ? SessionManager.listAll(progress, signal)
      : SessionManager.listAll(dir, progress, signal);
}

export default function (pi: ExtensionAPI): void {
  let unsubscribe: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (ctx.mode !== "tui") return;
    // A zero-line, immediately removed widget obtains the active TUI through
    // the public API, without replacing anybody's editor or renderer.
    let terminal: TUI | undefined;
    const widgetKey = "session-picker:runtime";
    ctx.ui.setWidget(widgetKey, (tui) => {
      terminal = tui;
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget(widgetKey, undefined);
    const routes: SubmitRoutes = new WeakMap();
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (getKeybindings().matches(data, "tui.input.submit")) {
        routeFocusedEditor(terminal?.getFocusedComponent() ?? null, ctx.ui.getEditorText(), routes);
      }
      // Do not consume keys: autocomplete, IME and other editors keep their behavior.
      return undefined;
    });
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  pi.registerCommand("session-picker", {
    description: "Resume sessions with child sessions collapsed (also used by /resume)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Session picker requires terminal UI", "warning"); return; }
      const state = newState();
      const sessionId = ctx.sessionManager.getSessionId();
      const current = () => {
        try { return ctx.sessionManager.getSessionId() === sessionId; } catch { return false; }
      };
      const currentPath = ctx.sessionManager.getSessionFile();
      while (true) {
        const choice = await ctx.ui.custom<Choice>((tui, theme, keys, done) => new SessionPicker(
          state, sessionLoader(ctx), theme, keys, () => tui.requestRender(), done, currentPath,
        ));
        if (!current()) return;
        if (!choice) return;
        try {
          if (choice.kind === "resume") {
            await ctx.switchSession(choice.path);
            return; // The old context is invalid after a successful switch.
          }
          if (choice.kind === "rename") {
            const name = await ctx.ui.input("Rename session", choice.name ?? "New name");
            if (!current()) return;
            if (name?.trim()) SessionManager.open(choice.path).appendSessionInfo(name.trim());
          } else {
            if (currentPath && pathKey(choice.path) === pathKey(currentPath)) {
              ctx.ui.notify("Cannot delete the currently active session", "error");
              continue;
            }
            if (!await ctx.ui.confirm("Delete session?", choice.path)) continue;
            if (!current()) return;
            let trashed = false;
            try {
              const result = await pi.exec("trash", choice.path.startsWith("-") ? ["--", choice.path] : [choice.path]);
              trashed = result.code === 0 || !existsSync(choice.path);
            } catch { /* The trash command may not be installed. */ }
            if (!current()) return;
            if (!trashed && await ctx.ui.confirm("Delete permanently?", "Trash is unavailable. Only this session file will be deleted; child sessions are kept.")) {
              if (!current()) return;
              await unlink(choice.path);
            }
          }
        } catch (error) {
          if (!current()) return;
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
    },
  });

  // A public-API escape hatch, retaining the complete upstream picker.
  pi.registerCommand("resume-native", {
    description: "Open Pi's original session picker",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Session picker requires terminal UI", "warning"); return; }
      const loader = sessionLoader(ctx);
      const path = await ctx.ui.custom<string | undefined>((tui, _theme, keys, done) => new SessionSelectorComponent(
        (progress, signal) => loader("current", progress ?? (() => {}), signal ?? new AbortController().signal),
        (progress, signal) => loader("all", progress ?? (() => {}), signal ?? new AbortController().signal),
        done, () => done(undefined), () => { done(undefined); ctx.shutdown(); },
        () => tui.requestRender(),
        { keybindings: keys, showRenameHint: true, renameSession: async (file, name) => { if (name.trim()) SessionManager.open(file).appendSessionInfo(name.trim()); } },
        ctx.sessionManager.getSessionFile(),
      ));
      if (path) await ctx.switchSession(path);
    },
  });
}
