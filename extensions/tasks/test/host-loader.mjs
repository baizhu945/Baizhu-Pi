import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(process.argv[2]);
const scratch = mkdtempSync(join(tmpdir(), "pi-tasks-loader-"));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_TASKS = "off";
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const settingsManager = SettingsManager.inMemory({ packages: [packageRoot] });
const loader = new DefaultResourceLoader({
  cwd: scratch,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.deepEqual(loaded.warnings ?? [], []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.deepEqual([...extension.tools.keys()].sort(), [
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
]);
assert(extension.commands.has("tasks"));
for (const { definition } of extension.tools.values()) {
  assert.doesNotMatch(JSON.stringify({ description: definition.description, promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines, parameters: definition.parameters }), /TaskExecute|TaskOutput|TaskStop/);
}
assert(!('agentType' in extension.tools.get('TaskCreate').definition.parameters.properties));
assert.equal([...extension.handlers.keys()].some(name => name.startsWith('subagents:')), false);
const context = { cwd: scratch, ui: { setWidget() {}, setStatus() {}, notify() {} } };
const execute = (name, params) => extension.tools.get(name).definition.execute(
  "host-loader-check", params, undefined, undefined, context,
);
const created = await execute("TaskCreate", { subject: "Host loader check", description: "Test the local extension" });
assert.match(created.content[0].text, /Task #1 created/);
assert.match((await execute("TaskList", {})).content[0].text, /Host loader check/);
await execute("TaskUpdate", { taskId: "1", status: "completed" });
assert.match((await execute("TaskGet", { taskId: "1" })).content[0].text, /completed/);
console.log("Pi host loader: zero errors/warnings; all 4 tools and /tasks registered; task CRUD passed.");
