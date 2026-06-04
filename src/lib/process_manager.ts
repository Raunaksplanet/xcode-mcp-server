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

export function createExec(
  command: string,
  args: string[],
  options: ExecFileOptions & {
    timeout?: number;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    logger.debug(`exec: ${command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

    const child = execFile(command, args, {
      ...options,
      maxBuffer: 100 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (child.pid != null) {
        untrackProcess(child.pid);
      }
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Command not found: ${command}. Is Xcode installed?`));
        return;
      }
      resolve({
        stdout: typeof stdout === 'string' ? stdout : (stdout?.toString() || ''),
        stderr: typeof stderr === 'string' ? stderr : (stderr?.toString() || ''),
        exitCode: error?.code === 'ENOENT' ? -1 : (error?.code ? parseInt(String(error.code), 10) || 1 : 0),
      });
    });

    if (child.pid != null) {
      trackProcess(command, args, () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ok */ }
        }, 5000);
      }, child.pid);
    }

    if (options.timeout && child.pid != null) {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
          logger.warn(`Process ${child.pid} timed out after ${options.timeout}ms`);
        } catch { /* ok */ }
      }, options.timeout);

      child.on('close', () => clearTimeout(timer));
    }

    if (options.onStdout && child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          options.onStdout!(line);
        }
      });
    }

    if (options.onStderr && child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          options.onStderr!(line);
        }
      });
    }
  });
}
