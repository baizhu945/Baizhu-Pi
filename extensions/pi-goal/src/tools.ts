import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import {
  formatStatus,
  GOAL_BLOCKED_TOOL,
  GOAL_COMPLETE_TOOL,
  GOAL_WAIT_TOOL,
  type GoalRuntime,
  goalIdRejectionReason,
  isContradictoryCompletionSummary,
  MAX_GOAL_ID_LENGTH,
  STATUS_KEY,
  transitionGoal,
  truncateNotification,
} from "./runtime.js";
import {
  createGoalWait,
  MAX_GOAL_WAIT_DELAY_MS,
  MAX_GOAL_WAIT_REASON_LENGTH,
  MIN_GOAL_WAIT_DELAY_MS,
  resolveGoalWaitDelay,
} from "./wait.js";

interface GoalCompleteDetails {
  goal: string;
  goal_id: string;
  summary: string;
}

interface GoalBlockedDetails {
  goal: string;
  goal_id: string;
  reason: string;
  evidence: string;
  repeated_turns: number;
}

interface GoalWaitDetails {
  goal: string;
  goal_id: string;
  reason: string;
  requested_resume_after_ms?: number;
  resume_after_ms?: number;
  resume_at?: number;
}

const MAX_GOAL_TEXT_LENGTH = 4_000;
const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime) {
  const goalCompleteTool = defineTool({
    name: GOAL_COMPLETE_TOOL,
    label: "Goal Complete",
    description:
      "Complete an explicitly active /goal using its current goal_id. Require verified completion of every requirement; tool visibility alone does not activate Goal mode.",
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "Current goal_id from the active /goal prompt.",
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: MAX_COMPLETION_SUMMARY_LENGTH,
        description:
          "Completed results and verification evidence.",
      }),
    }),
    renderResult(result) {
      return renderGoalCompletion(result);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const completedGoal = runtime.activeGoal;
      const goal = completedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";

      if (!completedGoal) {
        const rejection = "Goal completion rejected: no active goal.";
        notifyTerminal(ctx.ui, rejection, "warning");

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
      if (completedGoal.status === "active" && !runtime.ownsWorkflow(completedGoal)) {
        const rejection = "Goal completion rejected: active Goal no longer owns its workflow.";
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
        const rejection = "Goal completion rejected: current run does not own the active goal.";
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
      if (staleGoalRejection) {
        const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        if (completingDuringBudgetWrapUp) {
          runtime.recordGoalUsage(completedGoal, ctx);
          runtime.persistGoal(completedGoal);
          runtime.updateStatus(ctx, completedGoal);
          runtime.clearBudgetWrapUp();
        }

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: completingDuringBudgetWrapUp || undefined,
        };
      }
      if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
        const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
        notifyTerminal(ctx.ui, rejection, "warning");

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }

      const rejectionReason = !summary
        ? "summary is empty"
        : summary.length > MAX_COMPLETION_SUMMARY_LENGTH
          ? "summary is too long"
          : isContradictoryCompletionSummary(summary)
            ? "summary says the goal is not complete"
            : undefined;
      if (rejectionReason) {
        runtime.recordGoalUsage(completedGoal, ctx);
        runtime.persistGoal(completedGoal);
        runtime.updateStatus(ctx, completedGoal);
        const rejection = `Goal completion rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: completingDuringBudgetWrapUp || undefined,
        };
      }

      runtime.clearGoalWaitTimer();
      runtime.activeGoal = transitionGoal(completedGoal, "complete");
      runtime.setCompletionSummary(runtime.activeGoal.id, summary);
      runtime.recordGoalUsage(runtime.activeGoal, ctx);
      runtime.persistGoal(runtime.activeGoal);

      ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
      runtime.clearCompletedGoal(ctx);
      runtime.showCompletionStatus(ctx);
      notifyTerminal(ctx.ui, `Goal complete: ${goal}`, "info");

      return {
        content: toolContent(`Goal complete: ${summary}`),
        details: completionDetails(goal, requestedGoalId, summary),
        terminate: true,
      };
    },
  });

  const goalBlockedTool = defineTool({
    name: GOAL_BLOCKED_TOOL,
    label: "Goal Blocked",
    description:
      "Block an explicitly active /goal using its current goal_id only after the same evidenced blocker requires user/external action for three consecutive goal turns. Recoverable failures and unfinished work do not qualify.",
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_REASON_LENGTH,
        description: "The specific user or external action required to unblock the goal.",
      }),
      evidence: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
        description: "Concrete evidence from the repeated attempts that proves the impasse.",
      }),
      repeated_turns: Type.Integer({
        minimum: 3,
        description: "Number of separate turns spent trying to resolve this same blocker.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blockedGoal = runtime.activeGoal;
      const goal = blockedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      const repeatedTurns = typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
      const reject = (rejectionReason: string, terminate = false) => {
        const rejection = `goal_blocked rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!blockedGoal) return reject("no active goal");
      if (!runtime.canRecordGoalUsage()) {
        return reject("current run does not own the active goal");
      }
      const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (blockedGoal.status !== "active") {
        return reject(`goal is ${blockedGoal.status}, not active`);
      }
      if (!runtime.ownsWorkflow(blockedGoal)) return reject("active Goal no longer owns its workflow");
      if (!reason) return reject("reason is empty");
      if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
      if (!evidence) return reject("evidence is empty");
      if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
      if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
      if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

      const stoppedGoal = runtime.stopActiveGoal(ctx, {
        kind: "blocker_report",
        expectedGoalId: blockedGoal.id,
        reason,
      });
      if (!stoppedGoal) return reject("active goal changed before blocker transition");
      notifyTerminal(ctx.ui, `Goal blocked: ${truncateNotification(reason)}`, "warning");

      return {
        content: toolContent(`Goal blocked: ${reason}`),
        details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
        terminate: true,
      };
    },
  });

  const goalWaitTool = defineTool({
    name: GOAL_WAIT_TOOL,
    label: "Goal Wait",
    description: `Wait on an explicitly active /goal with its current goal_id for an arranged external wake event or one safety deadline. Call alone; not for ordinary unfinished work. Minimum delay: ${MIN_GOAL_WAIT_DELAY_MS}ms.`,
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_WAIT_REASON_LENGTH,
        description: "Why the goal is waiting and which external event should wake it.",
      }),
      resume_after_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_GOAL_WAIT_DELAY_MS,
          description: `One-shot safety wake in milliseconds; values below ${MIN_GOAL_WAIT_DELAY_MS} are clamped.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const activeGoal = runtime.activeGoal;
      const goal = activeGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const resumeAfterMs = typeof params.resume_after_ms === "number" ? params.resume_after_ms : undefined;
      const reject = (rejectionReason: string) => {
        const rejection = `goal_wait rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: waitDetails(goal, requestedGoalId, reason, resumeAfterMs),
        };
      };

      if (!activeGoal) return reject("no active goal");
      if (!runtime.canRecordGoalUsage()) {
        return reject("current run does not own the active goal");
      }
      const staleGoalRejection = goalIdRejectionReason(activeGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (activeGoal.status !== "active") {
        return reject(`goal is ${activeGoal.status}, not active`);
      }
      if (!runtime.ownsWorkflow(activeGoal)) return reject("active Goal no longer owns its workflow");
      if (activeGoal.waiting) return reject("goal is already waiting");
      if (!reason) return reject("reason is empty");
      if (reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return reject("reason is too long");
      if (
        resumeAfterMs !== undefined &&
        (!Number.isInteger(resumeAfterMs) || resumeAfterMs < 1 || resumeAfterMs > MAX_GOAL_WAIT_DELAY_MS)
      ) {
        return reject(`resume_after_ms must be a whole number from 1 to ${MAX_GOAL_WAIT_DELAY_MS}`);
      }

      const { requestedMs, effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
      const waiting = createGoalWait(reason, resumeAfterMs);
      const waitingGoal = runtime.enterGoalWait(ctx, activeGoal.id, waiting);
      if (!waitingGoal) return reject("active goal changed before waiting transition");
      const clamped = requestedMs !== undefined && effectiveMs !== requestedMs;
      notifyTerminal(ctx.ui, `Goal waiting: ${truncateNotification(reason)}`, "info");
      return {
        content: toolContent(
          clamped
            ? `Goal waiting: ${reason}\nRequested resume_after_ms ${requestedMs} was clamped to ${effectiveMs}.`
            : `Goal waiting: ${reason}`,
        ),
        details: waitDetails(
          goal,
          requestedGoalId,
          reason,
          effectiveMs,
          waiting.resumeAt,
          clamped ? requestedMs : undefined,
        ),
        terminate: true,
      };
    },
  });

  pi.registerTool(goalCompleteTool);
  pi.registerTool(goalBlockedTool);
  pi.registerTool(goalWaitTool);
}

interface GoalCompletionRenderResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export function goalCompletionMarkdown(result: GoalCompletionRenderResult) {
  const content = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const completionPrefix = "Goal complete:";
  if (!content.startsWith(completionPrefix)) return content;

  const details = result.details;
  const summary =
    details && typeof details === "object" && "summary" in details && typeof details.summary === "string"
      ? details.summary
      : content.slice(completionPrefix.length);
  const safeSummary = safeTerminalText(summary);
  return safeSummary ? `**Goal complete**\n\n${safeSummary}` : "**Goal complete**";
}

export function renderGoalCompletion(result: GoalCompletionRenderResult) {
  return new Markdown(goalCompletionMarkdown(result), 0, 0, getMarkdownTheme());
}

function toolContent(text: string) {
  return [
    {
      type: "text" as const,
      text: truncateHead(safeTerminalText(text), {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      }).content,
    },
  ];
}

function completionDetails(goal: string, goalId: string, summary: string): GoalCompleteDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH),
  };
}

function blockerDetails(
  goal: string,
  goalId: string,
  reason: string,
  evidence: string,
  repeatedTurns: number,
): GoalBlockedDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
    evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
    repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
  };
}

function waitDetails(
  goal: string,
  goalId: string,
  reason: string,
  resumeAfterMs: number | undefined,
  resumeAt?: number,
  requestedResumeAfterMs?: number,
): GoalWaitDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    reason: reason.slice(0, MAX_GOAL_WAIT_REASON_LENGTH),
    ...(requestedResumeAfterMs === undefined ? {} : { requested_resume_after_ms: requestedResumeAfterMs }),
    ...(resumeAfterMs === undefined ? {} : { resume_after_ms: resumeAfterMs }),
    ...(resumeAt === undefined ? {} : { resume_at: resumeAt }),
  };
}
