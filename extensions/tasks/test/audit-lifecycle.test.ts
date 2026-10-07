import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

afterEach(() => { delete process.env.PI_TASKS; });

describe("session-local memory stores", () => {
  it("PI_TASKS=off starts an empty list on a new session", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    initExtension(mock.pi as unknown as ExtensionAPI);
    const first = mockSessionCtx("first", { persisted: false });
    await mock.fireLifecycle("session_start", { reason: "startup" }, first);
    await mock.executeTool("TaskCreate", { subject: "Old", description: "Old requirements" });
    await mock.fireLifecycle("session_start", { reason: "new" }, mockSessionCtx("second", { persisted: false }));
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
    await mock.fireLifecycle("session_shutdown", {});
  });

  it("non-persisted forks keep a copy and new sessions do not retain it", async () => {
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    initExtension(mock.pi as unknown as ExtensionAPI);
    await mock.fireLifecycle("session_start", { reason: "startup" }, mockSessionCtx("parent", { persisted: false }));
    await mock.executeTool("TaskCreate", { subject: "Inherited", description: "Requirements", metadata: { note: "copy" } });
    await mock.fireLifecycle("session_start", { reason: "fork" }, mockSessionCtx("fork", { persisted: false }));
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("Inherited");
    await mock.fireLifecycle("session_start", { reason: "new" }, mockSessionCtx("fresh", { persisted: false }));
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
    await mock.fireLifecycle("session_shutdown", {});
  });
});
