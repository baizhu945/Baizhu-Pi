/**
 * @pi-unipi/fusion — Local Fusion prompt text
 *
 * Two prompt fragments make Fusion behave like a lead + sidekick pair rather
 * than two unrelated models:
 *
 *   - `leadPolicy()` is appended to the LEAD's system prompt on every turn
 *     while Fusion is active (before_agent_start). It is the delegate-by-
 *     default contract: what to hand off, what to keep, how to brief, how to
 *     review.
 *   - `sidekickSystemPrompt()` is appended to the SIDEKICK child's system
 *     prompt once at spawn. It tells the child what it is, what it never
 *     does, and how to report.
 *
 * Both are plain strings so they can be unit-tested and diffed. Keep them
 * self-contained; the sidekick never sees the lead's conversation.
 */

export interface FusionIdentity {
  leadName: string;
  leadEffort: string;
  sidekickName: string;
  sidekickEffort: string;
}

function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** One-line identity, e.g. `You are powered by Fusion (Claude Opus 4.6 Medium + GLM 5.3 Flash High).` */
export function fusionIdentityLine(id: FusionIdentity): string {
  const lead = id.leadEffort ? `${id.leadName} ${cap(id.leadEffort)}` : id.leadName;
  const side = id.sidekickEffort ? `${id.sidekickName} ${cap(id.sidekickEffort)}` : id.sidekickName;
  return `You are powered by Fusion (${lead} + ${side}).`;
}

export function leadPolicy(id: FusionIdentity): string {
  return `${fusionIdentityLine(id)}

Use \`sidekick\` for implementation and verification. It shares files with you, keeps its conversation and shell state, and receives only your brief. Supply the task, context, constraints, and checks; review its result before relying on it. Keep user communication, consequential decisions, correctness-critical work, and authority actions with the lead; urgent or trivial work may be done directly.
\`sidekick\` waits by default; block:false delivers a completion notification. A new call during a handoff steers the same sidekick. Use \`read_subagent\` with block:true to wait, rather than polling. Give concurrent work separate scopes.`;
}

/**
 * Recurring reminder appended to a direct edit/write by the lead while Fusion
 * is active (at most once per agent turn). Mirrors Devin's harness, which
 * re-issues this guidance on every direct implementation action rather than once.
 */
export const EDIT_NUDGE =
  "<system_guidance>Use sidekick for implementation and verification; keep correctness-critical, urgent, trivial, and authority actions with the lead.</system_guidance>";

/** Kept for compatibility with earlier imports; the nudge is no longer one-time. */
export const FIRST_EDIT_NUDGE = EDIT_NUDGE;

/**
 * Appended after the lead has run several consecutive non-trivial shell
 * commands itself without a handoff. Builds, tests, installs, environment
 * repair and multi-step shell work are the sidekick's job by default.
 */
export function bashNudge(count: number): string {
  return `<system_guidance>${String(count)} shell commands since the last handoff. Use sidekick for builds, tests, and environment work; keep correctness-critical or urgent work with the lead.</system_guidance>`;
}

export function sidekickSystemPrompt(id: FusionIdentity): string {
  return `Fusion sidekick for ${id.leadName}. Follow the brief within its scope and constraints; report ambiguity or conflicting evidence. Files are shared with the lead; your conversation and shell state persist across handoffs.
Leave user communication, new-secret requests, commits, pushes, PRs, and security settings to the lead. Destructive actions require explicit authorization in the brief.
Return a concise result with changed files, checks actually run and outcomes, remaining issues, artifact paths, and any running processes (PID/port).`;
}
