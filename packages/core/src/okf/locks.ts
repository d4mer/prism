/**
 * PRISM-27: bundle locks, shared across processes (the server, `prism
 * maintain` from cron, a second server on the same folder). Two locks, two
 * jobs:
 *
 *  - "write" is held for the few milliseconds of ONE mutation's critical
 *    section: file write + index.md chain + log.md append + derived index +
 *    optional git commit. It serializes individual writes between processes
 *    the way KnowledgeBase's in-memory queue already does within one. Without
 *    it, concurrent log.md read-modify-writes lose entries (measured: 1–11 of
 *    120 lost with three writer processes). A live write waits for it (up to
 *    15s by default) and fails LOUDLY with code LOCKED if it can't get it.
 *    It is never silently dropped.
 *  - "maintain" is held for a whole maintenance run (dream passes,
 *    embeddings), so two runs can never overlap. It does NOT block live
 *    writes: maintenance takes the write lock per mutation like everyone
 *    else, and live writes interleave between those.
 *
 * A lock is a file in <bundle>/.prism/locks/ created with O_EXCL (atomic),
 * holding pid, host, purpose, start time and a heartbeat that the holder
 * refreshes. It is stale, and may be taken over, when its heartbeat is older
 * than `staleMs`, or immediately when it belongs to a process on this host
 * that no longer exists (killed or crashed).
 *
 * Known limit: stale takeover re-checks the holder's token just before
 * removing the file, but two contenders can still race in the microseconds
 * between that check and the unlink. Every successful acquire therefore
 * verifies its own token is the one on disk. The residual window is the
 * same one proper-lockfile and similar libraries accept.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Bundle } from "./bundle.js";

export type LockName = "write" | "maintain";

export interface LockHolder {
  pid: number;
  host: string;
  purpose: string;
  started_at: string;
  heartbeat_at: string;
  token: string;
}

export interface LockOptions {
  purpose?: string;
  /** How long to keep retrying a held lock (default 0 = try once). */
  waitMs?: number;
  /** Heartbeat age after which a lock counts as abandoned. */
  staleMs?: number;
  /** How often the holder refreshes its heartbeat. */
  heartbeatMs?: number;
  log?: (message: string) => void;
}

export interface LockHandle {
  readonly name: LockName;
  readonly holder: LockHolder;
  release(): Promise<void>;
}

export class LockBusyError extends Error {
  constructor(
    readonly lock: LockName,
    readonly holder: LockHolder | undefined
  ) {
    super(
      holder
        ? `Bundle ${lock} lock is held by pid ${holder.pid} on ${holder.host} (${holder.purpose}, since ${holder.started_at})`
        : `Bundle ${lock} lock is held`
    );
    this.name = "LockBusyError";
  }
}

/** Documented defaults (README, "Concurrent writers"). */
export const LOCK_DEFAULTS: Record<LockName, Required<Pick<LockOptions, "waitMs" | "staleMs" | "heartbeatMs">>> = {
  write: { waitMs: 15_000, staleMs: 30_000, heartbeatMs: 5_000 },
  maintain: { waitMs: 0, staleMs: 10 * 60_000, heartbeatMs: 30_000 },
};

export function lockDir(bundle: Bundle): string {
  return path.join(bundle.root, ".prism", "locks");
}

function lockFile(bundle: Bundle, name: LockName): string {
  return path.join(lockDir(bundle), `${name}.lock`);
}

async function readHolder(file: string): Promise<LockHolder | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as LockHolder;
  } catch {
    return undefined; // missing, or half-written by its creator this instant
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists, owned by someone else. ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why a holder is stale, or undefined when it is live. */
export function staleReason(holder: LockHolder, staleMs: number, now = Date.now()): string | undefined {
  if (holder.host === os.hostname() && holder.pid !== process.pid && !pidAlive(holder.pid)) {
    return `holder pid ${holder.pid} is no longer running`;
  }
  const beat = Date.parse(holder.heartbeat_at);
  if (Number.isNaN(beat) || now - beat > staleMs) {
    return `no heartbeat for ${Math.round((now - (Number.isNaN(beat) ? 0 : beat)) / 1000)}s`;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function acquireLock(bundle: Bundle, name: LockName, options: LockOptions = {}): Promise<LockHandle> {
  const defaults = LOCK_DEFAULTS[name];
  const waitMs = options.waitMs ?? defaults.waitMs;
  const staleMs = options.staleMs ?? defaults.staleMs;
  const heartbeatMs = options.heartbeatMs ?? defaults.heartbeatMs;
  // Write-lock churn happens on every mutation; only maintenance is worth a log line.
  const log = options.log ?? (name === "maintain" ? (m: string) => console.error(`[prism] ${m}`) : () => {});
  const file = lockFile(bundle, name);
  await fs.mkdir(path.dirname(file), { recursive: true });

  const deadline = Date.now() + waitMs;
  let delay = 5;
  for (;;) {
    const now = new Date().toISOString();
    const holder: LockHolder = {
      pid: process.pid,
      host: os.hostname(),
      purpose: options.purpose ?? name,
      started_at: now,
      heartbeat_at: now,
      token: randomUUID(),
    };
    try {
      const fh = await fs.open(file, "wx");
      try {
        await fh.writeFile(JSON.stringify(holder));
      } finally {
        await fh.close();
      }
      if ((await readHolder(file))?.token === holder.token) {
        log(`${name} lock acquired (${holder.purpose})`);
        return makeHandle(file, name, holder, heartbeatMs, log);
      }
      // Lost a takeover race: someone replaced our file. Treat as busy.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const current = await readHolder(file);
    if (current) {
      const why = staleReason(current, staleMs);
      if (why) {
        // Re-check the token right before removing, so we never delete a lock
        // someone else took over a moment ago.
        if ((await readHolder(file))?.token === current.token) {
          await fs.rm(file, { force: true });
          log(`${name} lock taken over from pid ${current.pid} on ${current.host}: ${why}`);
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new LockBusyError(name, current);
    await sleep(delay);
    delay = Math.min(delay * 2, 100);
  }
}

function makeHandle(
  file: string,
  name: LockName,
  holder: LockHolder,
  heartbeatMs: number,
  log: (m: string) => void
): LockHandle {
  let released = false;
  const beat = setInterval(async () => {
    const current = await readHolder(file);
    if (current?.token !== holder.token) return; // not ours any more; never write over someone else
    holder.heartbeat_at = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(holder)).catch(() => {});
  }, heartbeatMs);
  beat.unref();
  return {
    name,
    holder,
    async release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      if ((await readHolder(file))?.token === holder.token) await fs.rm(file, { force: true });
      log(`${name} lock released (${holder.purpose})`);
    },
  };
}

/** Run fn while holding a lock; always releases, even when fn throws. */
export async function withLock<T>(bundle: Bundle, name: LockName, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const handle = await acquireLock(bundle, name, options);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

export type MaintenanceOutcome<T> = { ran: true; result: T } | { ran: false; reason: string; holder?: LockHolder };

/**
 * Run a maintenance job exclusively. If another run holds the lock, returns
 * {ran:false} immediately (cron-safe: a skipped run is not a failure).
 */
export async function withMaintenanceLock<T>(
  bundle: Bundle,
  purpose: string,
  fn: () => Promise<T>,
  options: Omit<LockOptions, "purpose"> = {}
): Promise<MaintenanceOutcome<T>> {
  let handle: LockHandle;
  try {
    handle = await acquireLock(bundle, "maintain", { ...options, purpose });
  } catch (err) {
    if (err instanceof LockBusyError) return { ran: false, reason: err.message, holder: err.holder };
    throw err;
  }
  try {
    return { ran: true, result: await fn() };
  } finally {
    await handle.release();
  }
}
