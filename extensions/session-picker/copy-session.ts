import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { pathKey } from "./tree.ts";

interface SessionCopyNode {
  path: string;
  key: string;
  parentKey?: string;
  label?: string;
}

const SESSION_COPY_MARKER = "session-picker:copy";

// A cloned root is linked to its source for picker tree display; don't recursively
// treat that previous copy as another subagent when the source is copied again.
function isGeneratedCopyRoot(sessionPath: string): boolean {
  return SessionManager.open(sessionPath).getEntries().some((entry) =>
    entry.type === "custom" && entry.customType === SESSION_COPY_MARKER &&
    (entry.data as { role?: unknown } | undefined)?.role === "root",
  );
}

function rewriteParentSession(sessionPath: string, parentSessionPath?: string): void {
  const contents = readFileSync(sessionPath, "utf8");
  const newline = contents.indexOf("\n");
  const firstLine = newline < 0 ? contents : contents.slice(0, newline);
  const header = JSON.parse(firstLine) as Record<string, unknown>;
  if (header.type !== "session") throw new Error(`Invalid session header in ${sessionPath}`);
  if (parentSessionPath) header.parentSession = parentSessionPath;
  else delete header.parentSession;
  const updated = `${JSON.stringify(header)}${newline < 0 ? "\n" : contents.slice(newline)}`;
  const temporaryPath = join(dirname(sessionPath), `.${basename(sessionPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, updated, { mode: statSync(sessionPath).mode & 0o777 });
    renameSync(temporaryPath, sessionPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* No temporary file was left behind. */ }
    throw error;
  }
}

/** Clone the active branch of a session and every persisted descendant session. */
export async function copySessionFamily(sourcePath: string): Promise<string> {
  const sourceKey = pathKey(sourcePath);
  const [allSessions, sourceDirectorySessions] = await Promise.all([
    SessionManager.listAll(),
    SessionManager.listAll(dirname(sourcePath)),
  ]);
  const sessionsByPath = new Map<string, (typeof allSessions)[number]>();
  for (const session of [...allSessions, ...sourceDirectorySessions]) {
    sessionsByPath.set(pathKey(session.path), session);
  }

  const childrenByParent = new Map<string, (typeof allSessions)[number][]>();
  for (const session of sessionsByPath.values()) {
    if (!session.parentSessionPath) continue;
    const parentKey = pathKey(session.parentSessionPath);
    const children = childrenByParent.get(parentKey) ?? [];
    children.push(session);
    childrenByParent.set(parentKey, children);
  }

  const rootInfo = sessionsByPath.get(sourceKey);
  const family: SessionCopyNode[] = [{ path: sourcePath, key: sourceKey, label: rootInfo?.name ?? rootInfo?.firstMessage }];
  const visited = new Set([sourceKey]);
  for (let index = 0; index < family.length; index++) {
    const parent = family[index]!;
    for (const child of childrenByParent.get(parent.key) ?? []) {
      const key = pathKey(child.path);
      if (visited.has(key) || isGeneratedCopyRoot(child.path)) continue;
      visited.add(key);
      family.push({ path: child.path, key, parentKey: parent.key, label: child.name ?? child.firstMessage });
    }
  }

  const copies = new Map<string, string>();
  const createdPaths: string[] = [];
  try {
    for (const node of family) {
      const original = SessionManager.open(node.path);
      const leafId = original.getLeafId();
      if (!leafId) throw new Error(`Cannot copy empty session: ${node.path}`);
      const copyPath = original.createBranchedSession(leafId);
      if (!copyPath) throw new Error(`Could not create a copy of session: ${node.path}`);
      createdPaths.push(copyPath);

      const parentCopyPath = node.parentKey ? copies.get(node.parentKey) : undefined;
      if (node.parentKey && !parentCopyPath) {
        throw new Error(`Could not find copied parent session for ${node.path}`);
      }
      rewriteParentSession(copyPath, parentCopyPath);

      const copyManager = SessionManager.open(copyPath);
      copyManager.appendCustomEntry(SESSION_COPY_MARKER, { sourcePath: node.path, role: node.parentKey ? "descendant" : "root" });
      const originalName = original.getSessionName() ?? node.label;
      const safeName = (originalName ?? "Session").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      copyManager.appendSessionInfo(`Copy of ${safeName || "Session"}`);
      copies.set(node.key, copyPath);
    }
  } catch (error) {
    for (const copyPath of createdPaths.reverse()) {
      try { unlinkSync(copyPath); } catch { /* Preserve the original error. */ }
    }
    throw error;
  }

  const rootCopyPath = copies.get(sourceKey);
  if (!rootCopyPath) throw new Error(`Could not copy session: ${sourcePath}`);
  return rootCopyPath;
}
