import {
  xcrun
} from "./chunk-TB6DDJUC.js";
import {
  logger
} from "./chunk-DZSLN5VB.js";

// src/lib/simulator_manager.ts
import { existsSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// src/lib/error_handler.ts
function buildFailed(details) {
  return {
    code: "BUILD_FAILED",
    message: "Xcode build failed",
    details,
    suggestion: "Check the build errors above. Common fixes:\n1. Resolve Swift compilation errors\n2. Check code signing configuration\n3. Ensure all dependencies are resolved\n4. Try: xcodebuild -resolvePackageDependencies"
  };
}
function simulatorTimeout(udid) {
  return {
    code: "SIMULATOR_TIMEOUT",
    message: `Simulator ${udid} did not boot within timeout`,
    suggestion: 'Try: xcrun simctl erase ${udid} && xcrun simctl boot ${udid}\nOr check simulator status: xcrun simctl list | grep -E "(Booted|Shutdown)"'
  };
}
function fileNotFound(path) {
  return {
    code: "FILE_NOT_FOUND",
    message: `File not found: ${path}`,
    suggestion: "Verify the file path is correct and relative to the project root."
  };
}
function pathTraversalDetected(path) {
  return {
    code: "PATH_TRAVERSAL",
    message: `Path traversal detected: ${path}`,
    suggestion: "All file paths must remain within the project directory. Use paths relative to the project root."
  };
}
function testFailure(details) {
  return {
    code: "TEST_FAILURE",
    message: "Tests failed",
    details,
    suggestion: "Check the test failures above. Common fixes:\n1. Fix assertion failures in test code\n2. Ensure test targets are configured correctly\n3. Check for simulator/device compatibility"
  };
}

// src/lib/simulator_manager.ts
async function listSimulators() {
  const result = await xcrun("simctl", ["list", "--json"]);
  return JSON.parse(result.stdout);
}
async function getAvailableSimulators() {
  const list = await listSimulators();
  const devices = [];
  for (const [runtime, runtimeDevices] of Object.entries(list.devices)) {
    if (!runtimeDevices) continue;
    for (const device of runtimeDevices) {
      if (device.isAvailable) {
        const osVersion = runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, ".").replace(/^(\w+)/, "$1 ");
        devices.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          osVersion,
          deviceType: device.deviceType,
          runtimeIdentifier: device.runtimeIdentifier || runtime,
          isAvailable: device.isAvailable
        });
      }
    }
  }
  return devices;
}
async function bootSimulator(udid, timeoutMs = 6e4) {
  logger.info(`Booting simulator ${udid}`);
  const { state } = await getSimulatorState(udid);
  if (state === "Booted") {
    logger.info(`Simulator ${udid} already booted`);
    return udid;
  }
  await xcrun("simctl", ["boot", udid]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentState = await getSimulatorState(udid);
    if (currentState.state === "Booted") {
      logger.info(`Simulator ${udid} booted successfully`);
      return udid;
    }
    await sleep(1e3);
  }
  throw simulatorTimeout(udid);
}
async function shutdownSimulator(udid) {
  logger.info(`Shutting down simulator ${udid}`);
  await xcrun("simctl", ["shutdown", udid]);
}
async function getSimulatorState(udid) {
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
async function findSimulator(query) {
  const devices = await getAvailableSimulators();
  return devices.find(
    (d) => d.udid === query || d.name.toLowerCase().includes(query.toLowerCase())
  );
}
async function installApp(udid, appPath) {
  if (!existsSync(appPath)) {
    throw new Error(`App not found at: ${appPath}`);
  }
  await xcrun("simctl", ["install", udid, appPath]);
}
async function launchApp(udid, bundleId, args = [], env = {}) {
  const launchArgs = [udid, bundleId];
  if (args.length > 0) {
    launchArgs.push(...args);
  }
  const envArgs = [];
  for (const [key, value] of Object.entries(env)) {
    envArgs.push(`${key}=${value}`);
  }
  if (envArgs.length > 0) {
    launchArgs.push("--environment", ...envArgs);
  }
  const result = await xcrun("simctl", ["launch", ...launchArgs]);
  const pidMatch = result.stdout.match(/(\d+)/);
  if (pidMatch && pidMatch[1]) {
    return parseInt(pidMatch[1], 10);
  }
  throw new Error(`Failed to launch ${bundleId} on simulator ${udid}`);
}
async function terminateApp(udid, bundleId) {
  await xcrun("simctl", ["terminate", udid, bundleId]);
}
async function getSimulatorLogs(udid, options = {}) {
  const args = ["spawn", udid, "log", "show", "--style", "compact"];
  if (options.lines) {
    args.push("--last", `${options.lines}`);
  }
  if (options.filter) {
    args.push("--predicate", options.filter);
  }
  const result = await xcrun("simctl", args);
  const entries = [];
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}[.0-9]*)\s+(.+)$/);
    if (match && match[1] && match[2]) {
      entries.push({
        timestamp: match[1],
        message: match[2]
      });
    } else {
      entries.push({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        message: line
      });
    }
    if (options.lines && entries.length >= options.lines) break;
  }
  return options.bundleId ? entries.filter((e) => e.message.includes(options.bundleId)) : entries;
}
async function screenshotSimulator(udid, outputPath) {
  const path = outputPath || join(tmpdir(), `simulator-${udid}-${Date.now()}.png`);
  await xcrun("simctl", ["io", udid, "screenshot", path]);
  return path;
}
async function recordSimulator(udid, outputPath, durationSeconds) {
  logger.info(`Recording simulator ${udid} for ${durationSeconds}s to ${outputPath}`);
  const processPromise = xcrun("simctl", ["io", udid, "recordVideo", "--type", "mp4", outputPath], {
    timeout: (durationSeconds + 30) * 1e3
  });
  await sleep(durationSeconds * 1e3);
  try {
    await xcrun("simctl", ["io", udid, "recordVideo", "--stop"]);
  } catch {
  }
  await processPromise.catch(() => {
  });
  return outputPath;
}
async function openURL(udid, url) {
  await xcrun("simctl", ["openurl", udid, url]);
}
async function setSimulatorLocation(udid, latitude, longitude) {
  await xcrun("simctl", ["location", udid, "set", `${latitude},${longitude}`]);
}
async function pushNotification(udid, bundleId, payload) {
  const tmpFile = join(tmpdir(), `simulator-push-${Date.now()}.json`);
  await writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf-8");
  try {
    await xcrun("simctl", ["push", udid, bundleId, tmpFile]);
  } finally {
    try {
      await unlink(tmpFile);
    } catch {
    }
  }
}
async function resetSimulator(udid) {
  const state = await getSimulatorState(udid);
  if (state.state === "Booted") {
    await shutdownSimulator(udid);
    await sleep(2e3);
  }
  await xcrun("simctl", ["erase", udid]);
  logger.info(`Simulator ${udid} reset to factory state`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  buildFailed,
  fileNotFound,
  pathTraversalDetected,
  testFailure,
  listSimulators,
  getAvailableSimulators,
  bootSimulator,
  shutdownSimulator,
  getSimulatorState,
  findSimulator,
  installApp,
  launchApp,
  terminateApp,
  getSimulatorLogs,
  screenshotSimulator,
  recordSimulator,
  openURL,
  setSimulatorLocation,
  pushNotification,
  resetSimulator
};
