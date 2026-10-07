import { createHash } from "node:crypto";

/** Keep ordinary identifiers readable while preventing path traversal and overlong filenames. */
export function safePathId(id: string): string {
  if (typeof id !== "string") throw new Error("Filesystem identifier must be a string");
  return id && id !== "." && id !== ".." && !/[\\/:\p{Cc}]/u.test(id) && Buffer.byteLength(id) <= 180
    ? id : `id-${createHash("sha256").update(id).digest("hex")}`;
}
