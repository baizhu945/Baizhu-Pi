import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { mockPi } from "./helpers/mock-pi.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

describe("four-tool task tracker", () => {
  it("registers four tools without an execution schema, prompt or RPC listener", () => {
    const mock = mockPi();
    const listen = vi.spyOn(mock.pi.events, "on");
    const emit = vi.spyOn(mock.pi.events, "emit");
    initExtension(mock.pi as unknown as ExtensionAPI);
    expect([...mock.tools.keys()]).toEqual(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
    expect(listen).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    for (const tool of mock.tools.values()) {
      expect(JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines, parameters: tool.parameters })).not.toMatch(/TaskExecute|TaskOutput|TaskStop/);
    }
    expect(mock.tools.get("TaskCreate").parameters.properties).not.toHaveProperty("agentType");
  });

  it("keeps owners, metadata and dependencies as task records", async () => {
    const mock = mockPi();
    initExtension(mock.pi as unknown as ExtensionAPI);
    await mock.executeTool("TaskCreate", { subject: "Implement", description: "Finish the implementation", metadata: { note: "requirements" } });
    await mock.executeTool("TaskCreate", { subject: "Verify", description: "Check the result" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"], owner: "reviewer" });
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("blocked by #1");
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    expect((await mock.executeTool("TaskList", {})).content[0].text).not.toContain("blocked by #1");
    expect((await mock.executeTool("TaskGet", { taskId: "2" })).content[0].text).toContain("Owner: reviewer");
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("requirements");
  });
});
