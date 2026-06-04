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
  return JSON.parse(result.stdout) as SimulatorList;
}

export async function getAvailableSimulators(): Promise<SimulatorDevice[]> {
  const list = await listSimulators();
  const devices: SimulatorDevice[] = [];

  for (const [runtime, runtimeDevices] of Object.entries(list.devices)) {
    if (!runtimeDevices) continue;
    for (const device of runtimeDevices) {
      if (device.isAvailable) {
        const osVersion = runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, '.').replace(/^(\w+)/, '$1 ');
        devices.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          osVersion,
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
  const launchArgs = [udid, bundleId];

  if (args.length > 0) {
    launchArgs.push(...args);
  }

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    envArgs.push(`${key}=${value}`);
  }
  if (envArgs.length > 0) {
    launchArgs.push('--environment', ...envArgs);
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
  const args = ['spawn', udid, 'log', 'show', '--style', 'compact'];
  if (options.lines) {
    args.push('--last', `${options.lines}`);
  }
  if (options.filter) {
    args.push('--predicate', options.filter);
  }

  const result = await xcrun('simctl', args);
  const entries: SimulatorLogEntry[] = [];

  for (const line of result.stdout.split('\n').filter(Boolean)) {
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

    if (options.lines && entries.length >= options.lines) break;
  }

  return options.bundleId
    ? entries.filter(e => e.message.includes(options.bundleId!))
    : entries;
}

export async function screenshotSimulator(udid: string, outputPath?: string): Promise<string> {
  const path = outputPath || join(tmpdir(), `simulator-${udid}-${Date.now()}.png`);
  await xcrun('simctl', ['io', udid, 'screenshot', path]);
  return path;
}

export async function recordSimulator(udid: string, outputPath: string, durationSeconds: number): Promise<string> {
  logger.info(`Recording simulator ${udid} for ${durationSeconds}s to ${outputPath}`);

  const processPromise = xcrun('simctl', ['io', udid, 'recordVideo', '--type', 'mp4', outputPath], {
    timeout: (durationSeconds + 30) * 1000,
  });

  await sleep(durationSeconds * 1000);

  try {
    await xcrun('simctl', ['io', udid, 'recordVideo', '--stop']);
  } catch {
    // Recording may already have been stopped
  }

  await processPromise.catch(() => {});
  return outputPath;
}

export async function openURL(udid: string, url: string): Promise<void> {
  await xcrun('simctl', ['openurl', udid, url]);
}

export async function setSimulatorLocation(udid: string, latitude: number, longitude: number): Promise<void> {
  await xcrun('simctl', ['location', udid, 'set', `${latitude},${longitude}`]);
}

export async function pushNotification(udid: string, bundleId: string, payload: Record<string, unknown>): Promise<void> {
  const tmpFile = join(tmpdir(), `simulator-push-${Date.now()}.json`);
  await writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    await xcrun('simctl', ['push', udid, bundleId, tmpFile]);
  } finally {
    try { await unlink(tmpFile); } catch { /* ok */ }
  }
}

export async function resetSimulator(udid: string): Promise<void> {
  const state = await getSimulatorState(udid);
  if (state.state === 'Booted') {
    await shutdownSimulator(udid);
    await sleep(2000);
  }
  await xcrun('simctl', ['erase', udid]);
  logger.info(`Simulator ${udid} reset to factory state`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
