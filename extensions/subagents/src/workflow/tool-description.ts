/** Model-facing API reference for SubagentWorkflow. */
export const fullWorkflowToolDescription = `Run an async JavaScript workflow; returns a task ID and delivers completion automatically. Choose scriptPath > script > name; inline scripts are saved. Saved workflows: .pi/workflows/, .agents/workflows/, or the agent directory's workflows/. args is the supplied JSON value.

Start with export const meta = { name: 'example', description: 'Example' }. Optional: whenToUse, phases [{title, detail?, model?}]. meta must be literal: no variables, calls, spreads, or interpolation.

API:
- agent(prompt, opts?) resolves to final text or validated JSON with schema; failure/skip returns null. Options: label, phase, schema, model, effort, isolation, agentType, gate, resume. Unknown keys fail. effort: minimal/low/medium/high/xhigh/max. isolation:'worktree' keeps changes on a branch and removes the checkout. gate runs a shell check; nonzero fails. resume uses a finished child's label, incompatible with agentType/model/effort/isolation/gate/schema. Structured output retries once.
- parallel(thunks) awaits concurrent calls; failures become null, fatal errors propagate.
- pipeline(items, ...stages): stage(previousResult, item, index); errors drop the item to null and skip later stages.
- phase(title), log(message): progress reporting.
- workflow(nameOrRef, args?): nested saved workflow or {scriptPath}; one level, shared limits.
- budget: total=null, spent()=output tokens, remaining()=Infinity.

Sandbox: JavaScript with top-level await; no filesystem/Node APIs, eval, Function, or nondeterministic time/random calls. Concurrency: max(1,min(16,CPUs-2)); limits: 1000 agents, 4096 parallel/pipeline items.
resumeFromRunId reuses a finished session run's unchanged successful prefix. scriptPath/runId identify the source/journal; <run id>.workflow.jsonl stores results.`;
