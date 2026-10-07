import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Serialize read/merge/write transactions across Pi processes; never wait on the UI thread. */
export function withFileLock<T>(file: string, action: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const token = randomUUID();
  let fd: number;
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Reclaim only a regular, unchanged lock whose recorded process is gone.
    const before = lstatSync(lock);
    if (!before.isFile()) throw new Error(`Unsafe goal lock: ${lock}`);
    const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647) {
      throw new Error(`Goal settings/state lock has an invalid owner: ${lock}`);
    }
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
    const now = lstatSync(lock);
    if (!dead || now.dev !== before.dev || now.ino !== before.ino) throw new Error(`Goal settings/state is busy: ${lock}`);
    unlinkSync(lock);
    fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  }
  const identity = fstatSync(fd);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    return action();
  } finally {
    closeSync(fd);
    try {
      const now = lstatSync(lock);
      if (now.isFile() && now.dev === identity.dev && now.ino === identity.ino &&
          JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock);
    } catch { /* Another owner or already removed: never remove their lock. */ }
  }
}
