import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { sessionTaskFile, workspaceSessionTaskFile } from "../src/task-paths.js";
import { TaskStore } from "../src/task-store.js";
import { mockCtx, mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

// Config is mocked rather than written to <cwd>/.pi/tasks-config.json: writing the
// real file would clobber the user's project settings, and reading it would let the
// developer's global <agentDir>/tasks-config.json leak into the results.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

// Force in-memory task store for all integration tests — prevents file-backed
// store from loading stale tasks across test instances.
beforeEach(() => {
  process.env.PI_TASKS = "off";
  config.current = {};
});
afterEach(() => { delete process.env.PI_TASKS; });

describe("Session task rehydration", () => {
  // Task paths resolve against the session workspace (ctx.cwd), so every test gets
  // its own: .pi/ in the real working directory holds the developer's own task list.
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-tasks-session-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  const sessionCtx = (sessionId: string) => mockSessionCtx(sessionId, { cwd });
  const sessionFile = (sessionId: string) => sessionTaskFile(cwd, sessionId, "session");

  it("renders default session-scoped tasks immediately after reload", async () => {
    const sessionId = `reload-${process.pid}-${Date.now()}`;
    const taskFile = sessionFile(sessionId);
    try {
      new TaskStore(taskFile).create("Review the rerun", "Inspect final results");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = sessionCtx(sessionId);

      await mock.fireLifecycle("session_start", { reason: "reload" }, ctx);

      expect(ctx.sessionManager.getSessionId).toHaveBeenCalledOnce();
      expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
        placement: "aboveEditor",
      });
    } finally {
      rmSync(taskFile, { force: true });
    }
  });

  it("renders tasks from a PI_TASKS path override after reload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-reload-"));
    const taskFile = join(directory, "tasks.json");
    try {
      new TaskStore(taskFile).create("Review the rerun", "Inspect final results");
      process.env.PI_TASKS = taskFile;
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = mockCtx(cwd);

      await mock.fireLifecycle("session_start", { reason: "reload" }, ctx);

      expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
        placement: "aboveEditor",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders persisted tasks after /resume", async () => {
    const sessionId = `resume-${process.pid}-${Date.now()}`;
    const taskFile = sessionFile(sessionId);
    try {
      new TaskStore(taskFile).create("Resume this", "Pick up where we left off");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = sessionCtx(sessionId);

      await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

      expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
        placement: "aboveEditor",
      });
    } finally {
      rmSync(taskFile, { force: true });
    }
  });

  it("switches the session-scoped store to the new session on /new", async () => {
    const sessionA = `switch-a-${process.pid}-${Date.now()}`;
    const sessionB = `switch-b-${process.pid}-${Date.now()}`;
    const fileA = sessionFile(sessionA);
    const fileB = sessionFile(sessionB);
    try {
      new TaskStore(fileA).create("Task in A", "desc");
      new TaskStore(fileB).create("Task in B", "desc");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);

      const ctxA = sessionCtx(sessionA);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
      expect(ctxA.sessionManager.getSessionId).toHaveBeenCalledOnce();

      // /new must re-point at the new session file. This was previously handled
      // by the never-emitted session_switch event, leaving the store on session A.
      const ctxB = sessionCtx(sessionB);
      await mock.fireLifecycle("session_start", { reason: "new" }, ctxB);
      expect(ctxB.sessionManager.getSessionId).toHaveBeenCalledOnce();
    } finally {
      rmSync(fileA, { force: true });
      rmSync(fileB, { force: true });
    }
  });

  it("seeds a forked session with an independent copy of the parent's tasks", async () => {
    const parent = `fork-parent-${process.pid}-${Date.now()}`;
    const child = `fork-child-${process.pid}-${Date.now()}`;
    const parentFile = sessionFile(parent);
    const childFile = sessionFile(child);
    try {
      new TaskStore(parentFile).create("Inherited task", "carry me into the fork");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);

      const ctxP = sessionCtx(parent);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctxP);

      // /fork re-points to a brand-new (empty) session file. Without seeding, the
      // fork would silently lose the parent's tasks; with it, the fork gets an
      // independent copy that does not write back to the parent.
      const ctxC = sessionCtx(child);
      await mock.fireLifecycle("session_start", { reason: "fork" }, ctxC);

      const forked = new TaskStore(childFile).list();
      expect(forked.map(t => t.subject)).toEqual(["Inherited task"]);

      // The fork is independent — mutating it must not touch the parent's file.
      new TaskStore(childFile).create("Fork-only task", "not in parent");
      expect(new TaskStore(parentFile).list().map(t => t.subject)).toEqual(["Inherited task"]);
    } finally {
      rmSync(parentFile, { force: true });
      rmSync(childFile, { force: true });
    }
  });
});

describe("Workspace-scoped store resolution", () => {
  // Paths come from ExtensionContext.cwd, not process.cwd(). The two match in the
  // terminal host, but a long-lived host serving sessions from another directory
  // would otherwise write every workspace's tasks into its own.
  const workspaces: string[] = [];
  const workspace = (label: string) => {
    const dir = mkdtempSync(join(tmpdir(), `pi-tasks-${label}-`));
    workspaces.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("namespaces session tasks by ctx.cwd instead of the host process cwd", async () => {
    const cwd = workspace("workspace");
    const sessionId = `ctx-cwd-${process.pid}-${Date.now()}`;
    const taskFile = workspaceSessionTaskFile(cwd, sessionId);
    const hostTaskFile = workspaceSessionTaskFile(process.cwd(), sessionId);
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockSessionCtx(sessionId, { cwd });

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", {
      subject: "Workspace task",
      description: "Must use the session workspace",
    }, ctx);

    expect(new TaskStore(taskFile).list().map(t => t.subject)).toEqual(["Workspace task"]);
    expect(existsSync(hostTaskFile)).toBe(false);
  });

  it("keeps identical session IDs isolated between workspaces", async () => {
    const cwdA = workspace("namespace-a");
    const cwdB = workspace("namespace-b");
    const sessionId = `shared-${process.pid}-${Date.now()}`;
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);

    const ctxA = mockSessionCtx(sessionId, { cwd: cwdA });
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
    await mock.executeTool("TaskCreate", { subject: "Workspace A", description: "d" }, ctxA);

    const ctxB = mockSessionCtx(sessionId, { cwd: cwdB });
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxB);
    await mock.executeTool("TaskCreate", { subject: "Workspace B", description: "d" }, ctxB);

    expect(sessionTaskFile(cwdA, sessionId, "session")).not.toBe(sessionTaskFile(cwdB, sessionId, "session"));
    expect(new TaskStore(sessionTaskFile(cwdA, sessionId, "session")).list().map(t => t.subject)).toEqual(["Workspace A"]);
    expect(new TaskStore(sessionTaskFile(cwdB, sessionId, "session")).list().map(t => t.subject)).toEqual(["Workspace B"]);
  });

  it("loads project scope from ctx.cwd and stores the shared task list there", async () => {
    const cwd = workspace("project-scope");
    config.current = { taskScope: "project" };
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", {
      subject: "Shared workspace task",
      description: "Must use the project-scoped store",
    }, ctx);

    const taskFile = join(cwd, ".pi", "tasks", "tasks.json");
    expect(new TaskStore(taskFile).list().map(t => t.subject)).toEqual(["Shared workspace task"]);
  });

  it("resolves relative PI_TASKS paths from ctx.cwd", async () => {
    const cwd = workspace("relative");
    process.env.PI_TASKS = "./state/tasks.json";
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", {
      subject: "Relative override task",
      description: "Must resolve relative to the session workspace",
    }, ctx);

    const taskFile = join(cwd, "state", "tasks.json");
    expect(new TaskStore(taskFile).list().map(t => t.subject)).toEqual(["Relative override task"]);
  });

  it("switches session stores when the session ID changes in the same workspace", async () => {
    const cwd = workspace("session-switch");
    const sessionA = `same-cwd-a-${process.pid}-${Date.now()}`;
    const sessionB = `same-cwd-b-${process.pid}-${Date.now()}`;
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctxA = mockSessionCtx(sessionA, { cwd });
    const ctxB = mockSessionCtx(sessionB, { cwd });

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
    await mock.executeTool("TaskCreate", { subject: "Task A", description: "Session A" }, ctxA);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxB);
    await mock.executeTool("TaskCreate", { subject: "Task B", description: "Session B" }, ctxB);

    const file = (id: string) => sessionTaskFile(cwd, id, "session");
    expect(new TaskStore(file(sessionA)).list().map(t => t.subject)).toEqual(["Task A"]);
    expect(new TaskStore(file(sessionB)).list().map(t => t.subject)).toEqual(["Task B"]);
  });

  it("keeps an in-memory store when the context cwd changes", async () => {
    const ctxA = mockCtx(workspace("memory-a"));
    const ctxB = mockCtx(workspace("memory-b"));
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
    await mock.executeTool("TaskCreate", { subject: "Memory task", description: "Keep me" }, ctxA);
    await mock.fireLifecycle("turn_start", {}, ctxB);

    const result = await mock.executeTool("TaskList", {}, ctxB);
    expect(result.content[0].text).toContain("Memory task");
  });
});

