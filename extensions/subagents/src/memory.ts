/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scopes:
 *   - "user"    → getAgentDir()/agent-memory/{agent-name}/ (default ~/.pi/agent/agent-memory/, honors $PI_CODING_AGENT_DIR)
 *   - "project" → .pi/agent-memory/{agent-name}/
 *   - "local"   → .pi/agent-memory-local/{agent-name}/
 *
 * The user scope previously hardcoded ~/.pi/agent-memory/. That legacy location
 * is still honored (read + write) when it exists and the new location doesn't,
 * so existing memories aren't orphaned.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MemoryScope } from "./types.js";

/** Maximum lines to read from MEMORY.md */
const MAX_MEMORY_LINES = 200;

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Return the first symlink component in a path, if any. */
function symlinkComponent(filePath: string): string | undefined {
  const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return current;
    } catch (error: any) {
      // Once a parent is missing, every later component is missing too. Other
      // errors (permissions, I/O) must remain visible to the caller.
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return undefined;
}

/** Whether any existing component of a path is a symbolic link. */
export function hasSymlinkComponent(filePath: string): boolean {
  return symlinkComponent(filePath) !== undefined;
}

/**
 * Safely read a file, rejecting symlinks in the file or any parent component.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  try {
    if (symlinkComponent(filePath) !== undefined || !existsSync(filePath)) return undefined;
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Resolve the memory directory path for a given agent + scope + cwd.
 * Throws if agentName contains path traversal characters.
 */
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
  if (isUnsafeName(agentName)) {
    throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
  }
  switch (scope) {
    case "user": {
      const current = join(getAgentDir(), "agent-memory", agentName);
      // Legacy location from when this path was hardcoded. Keep using it if it
      // already holds this agent's memory and the new location hasn't been
      // created yet — otherwise existing memories would be silently orphaned.
      const legacy = join(homedir(), ".pi", "agent-memory", agentName);
      if (!existsSync(current) && existsSync(legacy) && !isSymlink(legacy)) {
        return legacy;
      }
      return current;
    }
    case "project":
      return join(cwd, ".pi", "agent-memory", agentName);
    case "local":
      return join(cwd, ".pi", "agent-memory-local", agentName);
  }
}

/**
 * Ensure the memory directory exists, creating it if needed.
 * Refuses to create directories if any component in the path is a symlink
 * to prevent symlink-based directory traversal attacks.
 */
export function ensureMemoryDir(memoryDir: string): void {
  // Check every existing component, not only the final directory. A symlinked
  // `.pi` or `agent-memory` parent would otherwise make recursive mkdir/write
  // escape the intended project despite the final component being ordinary.
  const symlink = symlinkComponent(memoryDir);
  if (symlink !== undefined) {
    throw new Error(`Refusing to use symlinked memory path component: ${symlink}`);
  }
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
  const finalSymlink = symlinkComponent(memoryDir);
  if (finalSymlink !== undefined) {
    throw new Error(`Refusing to use symlinked memory path component: ${finalSymlink}`);
  }
}

/**
 * Read the first N lines of MEMORY.md from the memory directory, if it exists.
 * Returns undefined if no MEMORY.md exists or if the path is a symlink.
 */
export function readMemoryIndex(memoryDir: string): string | undefined {
  // Reject symlinked memory directories and parents, including a symlinked
  // `.pi` root or `agent-memory` component.
  if (symlinkComponent(memoryDir) !== undefined) return undefined;

  const memoryFile = join(memoryDir, "MEMORY.md");
  const content = safeReadFile(memoryFile);
  if (content === undefined) return undefined;

  const lines = content.split("\n");
  if (lines.length > MAX_MEMORY_LINES) {
    return lines.slice(0, MAX_MEMORY_LINES).join("\n") + "\n... (truncated at 200 lines)";
  }
  return content;
}

/**
 * Build the memory block to inject into the agent's system prompt.
 * Also ensures the memory directory exists (creates it if needed).
 */
export function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
  const memoryDir = resolveMemoryDir(agentName, scope, cwd);
  // Create the memory directory so the agent can immediately write to it
  ensureMemoryDir(memoryDir);

  const existingMemory = readMemoryIndex(memoryDir);

  const header = `# Agent Memory

You have a persistent memory directory at: ${memoryDir}/
Memory scope: ${scope}

Persistent across sessions.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nMemory index: ${join(memoryDir, "MEMORY.md")} (not created yet).`;

  const instructions = `

## Memory Instructions
- Keep MEMORY.md under 200 lines (later lines are truncated); link detailed files in ${memoryDir}/.
- Each memory file should use this frontmatter format:
  \`\`\`markdown
  ---
  name: <memory name>
  description: <one-line description>
  type: <user|feedback|project|reference>
  ---
  <memory content>
  \`\`\`
- Check existing entries before writing; update stale memories with read/write/edit.`;

  return header + memoryContent + instructions;
}

/**
 * Build a read-only memory block for agents that lack write/edit tools.
 * Does NOT create the memory directory — agents can only consume existing memory.
 */
export function buildReadOnlyMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
  const memoryDir = resolveMemoryDir(agentName, scope, cwd);
  const existingMemory = readMemoryIndex(memoryDir);

  const header = `# Agent Memory (read-only)

Memory scope: ${scope}
Read existing memories only; do not create or modify them.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nNo memory available.`;

  return header + memoryContent;
}
