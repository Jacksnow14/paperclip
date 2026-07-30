import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

// AUR-4388: a promotion reached from inside claimQueuedRun's cancellation paths
// (e.g. blocked-dependency or stale-issue gates) can call back into
// startNextQueuedRunForAgent for the *same* agentId before the outer call has
// returned -- releaseIssueExecutionAndPromote promotes a deferred wake and
// immediately re-drives its own agent. Without this, that re-entrant call
// waits on the lock it is itself still holding, only escaping via the 30s
// stale-lock fallback below. Tracking the agentIds already active in the
// current async call chain lets a genuine same-chain re-entry bypass the wait
// instead of deadlocking on itself, while unrelated concurrent callers for the
// same agentId (different call chains) still serialize normally.
const activeAgentIdsInChain = new AsyncLocalStorage<Set<string>>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const currentChain = activeAgentIdsInChain.getStore();
  if (currentChain?.has(agentId)) {
    // Re-entrant call for the same agentId within the same async call chain --
    // the outer call already holds this agent's slot, so run inline instead of
    // waiting on a lock we are ourselves still holding.
    return fn();
  }

  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const nextChain = new Set(currentChain);
  nextChain.add(agentId);
  const run = waitForPrevious.then(() => activeAgentIdsInChain.run(nextChain, fn));
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}
