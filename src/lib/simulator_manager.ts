import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { xcrun } from './xcode_runner.js';
import { logger } from './logger.js';
import { simulatorTimeout } from './error_handler.js';
import type {
  SimulatorDevice,
  SimulatorList,
  SimulatorLogEntry,
} from '../types/simulator.js';

export async function listSimulators(): Promise<SimulatorList> {
  const result = await xcrun('simctl', ['list', '--json']);
  try {
    return JSON.parse(result.stdout) as SimulatorList;
  } catch {
    throw new Error(`Failed to parse simctl output: ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
}

function parseOsVersion(runtime: string): string {
  // com.apple.CoreSimulator.SimRuntime.iOS-18-2 -> "iOS 18.2"
  const short = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
  const match = short.match(/^([A-Za-z]+)-(.+)$/);
  if (match?.[1] && match[2]) {
    return `${match[1]} ${match[2].replace(/-/g, '.')}`;
  }
  return short.replace(/-/g, '.');
}

export async function getAvailableSimulators(): Promise<SimulatorDevice[]> {
  const list = await listSimulators();
  const devices: SimulatorDevice[] = [];

  for (const [runtime, runtimeDevices] of Object.entries(list.devices)) {
    if (!runtimeDevices) continue;
    for (const device of runtimeDevices) {
      if (device.isAvailable) {
        devices.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          osVersion: parseOsVersion(runtime),
          deviceType: device.deviceType,
          runtimeIdentifier: device.runtimeIdentifier || runtime,
          isAvailable: device.isAvailable,
        });
      }
    }
  }

  return devices;
}

export async function bootSimulator(udid: string, timeoutMs = 60000): Promise<string> {
  logger.info(`Booting simulator ${udid}`);

  const { state } = await getSimulatorState(udid);
  if (state === 'Booted') {
    logger.info(`Simulator ${udid} already booted`);
    return udid;
  }

  await xcrun('simctl', ['boot', udid]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentState = await getSimulatorState(udid);
    if (currentState.state === 'Booted') {
      logger.info(`Simulator ${udid} booted successfully`);
      return udid;
    }
    await sleep(1000);
  }

  throw simulatorTimeout(udid);
}

export async function shutdownSimulator(udid: string): Promise<void> {
  logger.info(`Shutting down simulator ${udid}`);
  await xcrun('simctl', ['shutdown', udid]);
}

export async function getSimulatorState(udid: string): Promise<{ state: string; name: string }> {
  const list = await listSimulators();
  for (const devices of Object.values(list.devices)) {
    if (!devices) continue;
    for (const device of devices) {
      if (device.udid === udid) {
        return { state: device.state, name: device.name };
      }
    }
  }
  throw new Error(`Simulator ${udid} not found`);
}

export async function findSimulator(query: string): Promise<SimulatorDevice | undefined> {
  const devices = await getAvailableSimulators();
  return devices.find(d =>
    d.udid === query ||
    d.name.toLowerCase().includes(query.toLowerCase())
  );
}

export async function installApp(udid: string, appPath: string): Promise<void> {
  if (!existsSync(appPath)) {
    throw new Error(`App not found at: ${appPath}`);
  }
  await xcrun('simctl', ['install', udid, appPath]);
}

export async function launchApp(
  udid: string,
  bundleId: string,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<number> {
  // simctl launch [-w] [--environment NAME=VAL ...] <device> <bundle> [argv]:
  // options MUST precede the device and bundle identifiers.
  const launchArgs: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    launchArgs.push('--environment', `${key}=${value}`);
  }

  launchArgs.push(udid, bundleId);

  if (args.length > 0) {
    launchArgs.push(...args);
  }

  const result = await xcrun('simctl', ['launch', ...launchArgs]);
  const pidMatch = result.stdout.match(/(\d+)/);
  if (pidMatch && pidMatch[1]) {
    return parseInt(pidMatch[1], 10);
  }
  throw new Error(`Failed to launch ${bundleId} on simulator ${udid}`);
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  await xcrun('simctl', ['terminate', udid, bundleId]);
}

export async function getSimulatorLogs(
  udid: string,
  options: { bundleId?: string; lines?: number; filter?: string } = {}
): Promise<SimulatorLogEntry[]> {
  // `log show --last` takes a timespan (5m/1h/boot), not a line count, so we
  // fetch the stream and slice the last N entries in code instead.
  const args = ['spawn', udid, 'log', 'show', '--style', 'compact', '--last', 'boot'];
  if (options.filter) {
    args.push('--predicate', options.filter);
  }

  const result = await xcrun('simctl', args);
  const entries: SimulatorLogEntry[] = [];

  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}[.0-9]*)\s+(.+)$/);
    if (match && match[1] && match[2]) {
      entries.push({
        timestamp: match[1],
        message: match[2],
      });
    } else {
      entries.push({
        timestamp: new Date().toISOString(),
        message: line,
      });
    }
  }

  const filtered = options.bundleId
    ? entries.filter(e => e.message.includes(options.bundleId!))
    : entries;
  const lines = options.lines && options.lines > 0 ? options.lines : filtered.length;
  return filtered.slice(-lines);
}

export async function screenshotSimulator(udid: string, outputPath?: string): Promise<string> {
  const path = outputPath || join(tmpdir(), `simulator-${udid}-${Date.now()}.png`);
  if (!path.toLowerCase().endsWith('.png')) {
    throw new Error('Screenshot output path must end with .png');
  }
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await xcrun('simctl', ['io', udid, 'screenshot', path]);
  return path;
}

export async function recordSimulator(udid: string, outputPath: string, durationSeconds: number): Promise<string> {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
    throw new Error('Recording duration must be between 1 and 300 seconds.');
  }
  if (!outputPath.toLowerCase().endsWith('.mp4') && !outputPath.toLowerCase().endsWith('.mov')) {
    throw new Error('Recording output path must end with .mp4 or .mov');
  }
  logger.info(`Recording simulator ${udid} for ${durationSeconds}s to ${outputPath}`);

  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(outputPath), { recursive: true });

  // simctl recordVideo runs until it receives SIGINT: spawn it directly and
  // interrupt it after the requested duration (there is no '--stop' subcommand).
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', outputPath], {
      stdio: 'ignore',
    });
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) rejectPromise(err);
      else resolvePromise();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGINT');
      } catch {
        done(new Error('Failed to stop the recording process.'));
        return;
      }
      // If SIGINT is ignored, escalate shortly after.
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch { /* already gone */ }
      }, 5000).unref?.();
    }, durationSeconds * 1000);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      done(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // simctl exits 0 on SIGINT; SIGKILL-escalated runs surface here too.
      if (code === 0 || code === null) done();
      else done(new Error(`recordVideo exited with code ${code}`));
    });
  });
  return outputPath;
}

export async function openURL(udid: string, url: string): Promise<void> {
  await xcrun('simctl', ['openurl', udid, url]);
}

export async function setSimulatorLocation(udid: string, latitude: number, longitude: number): Promise<void> {
  await xcrun('simctl', ['location', udid, 'set', `${latitude},${longitude}`]);
}

export async function pushNotification(udid: string, bundleId: string, payload: Record<string, unknown>): Promise<void> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Push payload must be a JSON object.');
  }
  const serialized = JSON.stringify(payload);
  if (serialized.length > 64 * 1024) {
    throw new Error('Push payload exceeds 64KB.');
  }
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'simulator-push-'));
  const tmpFile = join(dir, 'payload.apns');
  await writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    await xcrun('simctl', ['push', udid, bundleId, tmpFile]);
  } finally {
    try { await unlink(tmpFile); } catch { /* ok */ }
    try {
      const { rmdir } = await import('node:fs/promises');
      await rmdir(dir);
    } catch { /* ok */ }
  }
}

export async function resetSimulator(udid: string): Promise<void> {
  const state = await getSimulatorState(udid);
  if (state.state === 'Booted') {
    await shutdownSimulator(udid);
    // Poll until shutdown completes instead of sleeping a fixed 2s.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const current = await getSimulatorState(udid);
      if (current.state !== 'Booted') break;
      await sleep(1000);
    }
  }
  await xcrun('simctl', ['erase', udid]);
  logger.info(`Simulator ${udid} reset to factory state`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
