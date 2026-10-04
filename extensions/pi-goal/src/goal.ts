import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRunController } from "./run-protocol.js";
import { GoalRuntime } from "./runtime.js";
import { registerGoalTools } from "./tools.js";
import { createGoalToolGate } from "./tool-gate.js";

interface GoalOptions {
  settingsPath?: string;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  const commands = new GoalCommandController(runtime);
  const runController = new GoalRunController(runtime, commands);

  // Keep /goal available while leaving an unused session's model inputs neutral.
  runtime.setGoalToolGate(createGoalToolGate(pi, () => registerGoalTools(pi, runtime)));
  runController.register(pi);
  registerGoalCommand(pi, runtime, commands, options);
  registerGoalLifecycle(pi, runtime, runController, options);
  pi.on("before_agent_start", (event, ctx) => {
    if (!runtime.goalToolsRegistered || runtime.activeGoal?.status === "active" || runtime.hasActiveBudgetWrapUp()) return;
    runtime.ensureInactiveGoalContextContract(ctx);
    // Pi snapshots the tool selection before dispatching these hooks. A stop
    // during dispatch must also revoke our names from that pending snapshot.
    if (event.systemPromptOptions) event.systemPromptOptions.selectedTools = pi.getActiveTools();
  });
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
  registerGoalRuntime(pi, options);
}

export {
  assistantUsageTokens,
  cumulativeAssistantTokens,
  formatDuration,
  formatTokenCount,
} from "./accounting.js";

export {
  completeGoalArguments,
  parseCommand,
  parseTokenBudget,
  validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt } from "./prompts.js";

export {
  findFinalAssistantMessage,
  formatStatus,
  isContradictoryCompletionSummary,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
} from "./runtime.js";
