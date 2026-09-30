/** Model-facing API reference for SubagentWorkflow, without parent-agent policies. */
export const fullWorkflowToolDescription = `Run a JavaScript workflow that coordinates subagents. Returns a task ID immediately; completion delivers the result automatically. Progress is visible in /agents → Workflows.

Source: script (inline), scriptPath (file), or name (saved workflow). Precedence: scriptPath > script > name. Inline source is saved automatically. Saved workflows live in .pi/workflows/, .agents/workflows/, or the agent directory's workflows/ folder. args is exposed to the script as its JSON value.

Format: export const meta = { name: 'example', description: 'Example workflow' }, followed by a script body with top-level await. Optional meta fields: whenToUse and phases (entries contain title and optional detail/model). meta is a literal object; variables, calls, spreads, and interpolation are not accepted.

Script API:
- agent(prompt, opts?) returns a Promise of the child's final text, or validated JSON when opts.schema is provided. Skipped or failed children return null. Options: label, phase, schema, model, effort, isolation, agentType, gate, resume. Unknown options are rejected.
- label names the call; phase assigns its progress group. model overrides the inherited model; effort overrides thinking level (minimal, low, medium, high, xhigh, max). agentType selects an available agent configuration. schema is a JSON Schema for StructuredOutput; an unanswered structured result is retried once, then fails.
- isolation: 'worktree' creates an isolated checkout, removed on completion with changes retained on a branch. gate is a shell command run after the child; nonzero exit fails the call. resume names a finished child by label and preserves its context; incompatible with agentType, model, effort, isolation, gate, or schema.
- pipeline(items, ...stages) runs each item through its stages without a cross-item barrier. A stage receives (previousResult, originalItem, index); a thrown error drops that item to null and skips its remaining stages.
- parallel(thunks) runs promise-returning functions concurrently and waits for all. Failed items become null; fatal run errors propagate.
- phase(title) sets the progress group for subsequent calls. log(message) emits a progress message.
- workflow(nameOrRef, args?) runs a saved workflow or {scriptPath} as a nested step. It shares this run's limits and budget; nesting is one level deep.
- budget exposes total (null), spent() (output tokens), and remaining() (Infinity).

The body runs in an async JavaScript sandbox, not TypeScript. Filesystem/Node.js APIs, eval, Function, Date.now(), Math.random(), and argumentless new Date() are unavailable. Concurrency is max(1, min(16, available CPUs - 2)); excess calls queue. Limits: 1000 agents per run and 4096 items per parallel/pipeline call.

Example:
export const meta = { name: 'inspect', description: 'Inspect files' }
const results = await parallel(args.map(path => () => agent('Inspect ' + path)))
return results

Run recovery: resumeFromRunId reuses the longest unchanged prefix of calls from a finished run in this session. The first changed or failed call and subsequent calls run again. The returned scriptPath and runId identify the source and resume journal; <run id>.workflow.jsonl contains each child's actual result.`;
