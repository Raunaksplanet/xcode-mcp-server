import { execFile, type ExecFileOptions } from 'node:child_process';
import { logger } from './logger.js';

interface TrackedProcess {
  pid: number;
  command: string;
  args: string[];
  startTime: number;
  kill: () => void;
}

const trackedProcesses: Map<number, TrackedProcess> = new Map();

export function trackProcess(
  command: string,
  args: string[],
  kill: () => void,
  pid: number
): void {
  trackedProcesses.set(pid, {
    pid,
    command,
    args,
    startTime: Date.now(),
    kill,
  });
  logger.debug(`Tracking process ${pid}: ${command} ${args.join(' ')}`);
}

export function untrackProcess(pid: number): void {
  trackedProcesses.delete(pid);
  logger.debug(`Untracked process ${pid}`);
}

export function killAllChildProcesses(): void {
  const count = trackedProcesses.size;
  if (count === 0) return;

  logger.info(`Cleaning up ${count} tracked child process(es)...`);
  for (const [pid, proc] of trackedProcesses) {
    try {
      logger.debug(`Killing process ${pid} (${proc.command})`);
      proc.kill();
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may already be dead
      }
    }
  }
  trackedProcesses.clear();
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// Simple FIFO semaphore to bound concurrent heavyweight CLI calls
// (xcodebuild corrupts DerivedData when run fully in parallel).
const MAX_CONCURRENT_BUILDS = 2;
let activeBuilds = 0;
const buildQueue: Array<() => void> = [];

function acquireBuildSlot(): Promise<() => void> {
  if (activeBuilds < MAX_CONCURRENT_BUILDS) {
    activeBuilds++;
    return Promise.resolve(releaseBuildSlot);
  }
  return new Promise((resolve) => {
    buildQueue.push(() => {
      activeBuilds++;
      resolve(releaseBuildSlot);
    });
  });
}

function releaseBuildSlot(): void {
  activeBuilds = Math.max(0, activeBuilds - 1);
  const next = buildQueue.shift();
  if (next) next();
}

/** Wrap an async fn so at most MAX_CONCURRENT_BUILDS run at once. */
export async function withBuildSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireBuildSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function createExec(
  command: string,
  args: string[],
  options: ExecFileOptions & {
    timeout?: number;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
  } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    logger.debug(`exec: ${command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

    // Strip our custom options before passing to execFile (it does not know them).
    const { timeout, onStdout, onStderr, ...execOptions } = options;

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const child = execFile(command, args, {
      ...execOptions,
      maxBuffer: 25 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      if (child.pid != null) {
        untrackProcess(child.pid);
      }
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Command not found: ${command}. Is Xcode installed?`));
        return;
      }
      // execFile reports timeouts with killed===true / signal SIGTERM.
      const execError = error as (Error & { code?: unknown; killed?: boolean; signal?: string }) | null;
      if (execError?.killed || timedOut) {
        timedOut = true;
      }
      let exitCode: number | null;
      if (typeof execError?.code === 'number') {
        exitCode = execError.code;
      } else if (execError) {
        exitCode = 1;
      } else {
        exitCode = 0;
      }
      resolve({
        stdout: typeof stdout === 'string' ? stdout : (stdout?.toString() || ''),
        stderr: typeof stderr === 'string' ? stderr : (stderr?.toString() || ''),
        exitCode,
        timedOut,
      });
    });

    if (child.pid != null) {
      trackProcess(command, args, () => {
        try { child.kill('SIGTERM'); } catch { /* ok */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ok */ }
        }, 5000).unref?.();
      }, child.pid);
    }

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
          logger.warn(`Process ${child.pid} timed out after ${timeout}ms`);
        } catch { /* ok */ }
        // Give the process a grace period, then force-kill so execFile's
        // callback fires and the promise always settles.
        setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch { /* ok */ }
        }, 5000).unref?.();
      }, timeout);
      // Do not keep the event loop alive just for the timeout timer.
      timer.unref?.();
    }

    if (onStdout && child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try { onStdout(line); } catch { /* caller callback must not crash exec */ }
        }
      });
    }

    if (onStderr && child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try { onStderr!(line); } catch { /* ok */ }
        }
      });
    }
  });
}
