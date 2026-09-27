import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const WAIT_MS = 40;
const TIMEOUT_MS = 30_000;
const MALFORMED_LOCK_GRACE_MS = 5_000;

type LockOwner = { pid: number; token: string; createdAt: number };

export class ResearchStateLockError extends Error {
  constructor() {
    super("Research records are busy in another process; retry shortly");
    this.name = "ResearchStateLockError";
  }
}

/** Serialize read/modify/replace across backend processes sharing one data root. */
export async function withResearchStateLock<T>(stateFile: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${stateFile}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
  const deadline = Date.now() + TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
        return await action();
      } finally {
        await handle.close();
        // A recovered stale lock may have been replaced. Only release ours.
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
          if (current.token === owner.token) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverDeadOwner(lockPath);
      if (Date.now() >= deadline) throw new ResearchStateLockError();
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS + Math.floor(Math.random() * WAIT_MS)));
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function recoverDeadOwner(lockPath: string): Promise<void> {
  // Exactly one process may inspect and retire a dead owner at a time. Without
  // this guard, a delayed contender could rename a *new* live lock based on an
  // earlier observation of the old lock.
  const recoveryPath = `${lockPath}.recovery`;
  let recovery: Awaited<ReturnType<typeof open>>;
  try { recovery = await open(recoveryPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    await recoverDeadOwnerWhileGuarded(lockPath);
  } finally {
    await recovery.close();
    await unlink(recoveryPath);
  }
}

async function recoverDeadOwnerWhileGuarded(lockPath: string): Promise<void> {
  let owner: LockOwner | undefined;
  let ageMs = 0;
  try {
    const [content, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    ageMs = Date.now() - info.mtimeMs;
    try { owner = JSON.parse(content) as LockOwner; } catch { /* The creator may still be writing. */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (owner && processIsAlive(owner.pid)) return;
  if (!owner && ageMs < MALFORMED_LOCK_GRACE_MS) return;
  const stalePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, stalePath);
    await unlink(stalePath);
  } catch (error) {
    // Another process may have recovered it, or Windows may still have the
    // lock open. In both cases retry normal acquisition instead of guessing.
    if (!["ENOENT", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
