import {
  logger
} from "./chunk-DZSLN5VB.js";

// src/lib/xcode_runner.ts
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// src/lib/process_manager.ts
import { execFile } from "child_process";
var trackedProcesses = /* @__PURE__ */ new Map();
function trackProcess(command, args, kill, pid) {
  trackedProcesses.set(pid, {
    pid,
    command,
    args,
    startTime: Date.now(),
    kill
  });
  logger.debug(`Tracking process ${pid}: ${command} ${args.join(" ")}`);
}
function untrackProcess(pid) {
  trackedProcesses.delete(pid);
  logger.debug(`Untracked process ${pid}`);
}
function killAllChildProcesses() {
  const count = trackedProcesses.size;
  if (count === 0) return;
  logger.info(`Cleaning up ${count} tracked child process(es)...`);
  for (const [pid, proc] of trackedProcesses) {
    try {
      logger.debug(`Killing process ${pid} (${proc.command})`);
      proc.kill();
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
  }
  trackedProcesses.clear();
}
function createExec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    logger.debug(`exec: ${command} ${args.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")}`);
    const child = execFile(command, args, {
      ...options,
      maxBuffer: 100 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (child.pid != null) {
        untrackProcess(child.pid);
      }
      if (error && error.code === "ENOENT") {
        reject(new Error(`Command not found: ${command}. Is Xcode installed?`));
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : stdout?.toString() || "",
        stderr: typeof stderr === "string" ? stderr : stderr?.toString() || "",
        exitCode: error?.code === "ENOENT" ? -1 : error?.code ? parseInt(String(error.code), 10) || 1 : 0
      });
    });
    if (child.pid != null) {
      trackProcess(command, args, () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
          }
        }, 5e3);
      }, child.pid);
    }
    if (options.timeout && child.pid != null) {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          logger.warn(`Process ${child.pid} timed out after ${options.timeout}ms`);
        } catch {
        }
      }, options.timeout);
      child.on("close", () => clearTimeout(timer));
    }
    if (options.onStdout && child.stdout) {
      child.stdout.on("data", (data) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          options.onStdout(line);
        }
      });
    }
    if (options.onStderr && child.stderr) {
      child.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          options.onStderr(line);
        }
      });
    }
  });
}

// src/lib/xcode_runner.ts
function sanitizeArgs(args) {
  return args.map((a) => {
    if (a.includes("$") || a.includes("`") || a.includes(";") || a.includes("|")) {
      return a.replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/;/g, "\\;").replace(/\|/g, "\\|");
    }
    return a;
  });
}
async function xcrun(command, args, options = {}) {
  const allArgs = sanitizeArgs([command, ...args]);
  return createExec("xcrun", allArgs, {
    timeout: options.timeout,
    onStdout: options.onStdout,
    onStderr: options.onStderr
  });
}
async function xcodebuild(args, options = {}) {
  const allArgs = sanitizeArgs(args);
  return createExec("xcodebuild", allArgs, {
    timeout: options.timeout,
    onStdout: options.onProgress || options.onProgress,
    onStderr: options.onProgress || options.onProgress
  });
}
function parseBuildOutput(stdout, stderr) {
  const errors = [];
  const warnings = [];
  const lines = (stdout + "\n" + stderr).split("\n");
  for (const line of lines) {
    const errorMatch = line.match(/^(?:(.+?):(\d+):(?:\d+)?:\s*)?error:\s*(.+)$/);
    if (errorMatch) {
      errors.push({
        type: "error",
        file: errorMatch[1],
        line: errorMatch[2] ? parseInt(errorMatch[2], 10) : void 0,
        message: errorMatch[3]?.trim() || ""
      });
      continue;
    }
    const warningMatch = line.match(/^(?:(.+?):(\d+):(?:\d+)?:\s*)?warning:\s*(.+)$/);
    if (warningMatch) {
      warnings.push({
        type: "warning",
        file: warningMatch[1],
        line: warningMatch[2] ? parseInt(warningMatch[2], 10) : void 0,
        message: warningMatch[3]?.trim() || ""
      });
      continue;
    }
    const fixItMatch = line.match(/^\s*fix-it:\s*(.+?):(\d+):(\d+):\s*(.+)$/);
    if (fixItMatch) {
      if (errors.length > 0) {
        errors[errors.length - 1].fixIt = fixItMatch[0];
      }
      continue;
    }
    const noteMatch = line.match(/^(?:(.+?):(\d+):(?:\d+)?:\s*)?note:\s*(.+)$/);
    if (noteMatch) {
      errors.push({
        type: "note",
        file: noteMatch[1],
        line: noteMatch[2] ? parseInt(noteMatch[2], 10) : void 0,
        message: noteMatch[3]?.trim() || ""
      });
    }
  }
  return { errors, warnings };
}
function getBuildTime(stdout) {
  const match = stdout.match(/(\d+\.\d+)\s+seconds\s+\(xcodebuild\)/);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  const match2 = stdout.match(/Build\s+succeeded.*?in\s+(\d+\.\d+)\s+sec/);
  if (match2 && match2[1]) {
    return parseFloat(match2[1]);
  }
  return 0;
}
function buildSucceeded(stdout) {
  return stdout.includes("BUILD SUCCEEDED");
}
function buildFailedCheck(stdout) {
  return stdout.includes("BUILD FAILED");
}
async function runBuild(options) {
  const args = [];
  if (options.clean) {
    args.push("clean");
  }
  args.push("build");
  if (options.scheme) {
    args.push("-scheme", options.scheme);
  }
  if (options.configuration) {
    args.push("-configuration", options.configuration);
  }
  if (options.destination) {
    args.push("-destination", options.destination);
  }
  if (options.derivedDataPath) {
    args.push("-derivedDataPath", options.derivedDataPath);
  }
  if (options.xcargs) {
    args.push(...options.xcargs);
  }
  const startTime = Date.now();
  const progressLog = [];
  const result = await xcodebuild(args, {
    timeout: options.timeout,
    onProgress: (line) => {
      progressLog.push(line);
      if (options.onProgress) options.onProgress(line);
    }
  });
  const buildTime = (Date.now() - startTime) / 1e3;
  const combinedOutput = result.stdout + "\n" + result.stderr;
  const fullLog = progressLog.join("\n") || combinedOutput;
  const parsed = parseBuildOutput(result.stdout, result.stderr);
  const success = buildSucceeded(result.stdout);
  if (!success) {
    logger.error("Build failed:", result.stderr.slice(0, 500));
  } else {
    const time = getBuildTime(result.stdout) || buildTime;
    logger.info(`Build succeeded in ${time.toFixed(1)}s`);
  }
  return {
    success,
    scheme: options.scheme || "",
    configuration: options.configuration || "Debug",
    destination: options.destination,
    buildTimeSeconds: getBuildTime(result.stdout) || buildTime,
    errors: parsed.errors,
    warnings: parsed.warnings,
    outputLog: fullLog
  };
}
async function getBuildSettings(target, configuration) {
  const args = ["-showBuildSettings", "-target", target, "-configuration", configuration];
  const result = await xcodebuild(args);
  const settings = {};
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s+(\S+)\s+=\s+(.+)$/);
    if (match && match[1] && match[2]) {
      settings[match[1]] = match[2].trim();
    }
  }
  return settings;
}
async function resolvePackageDependencies(projectPath) {
  const args = ["-resolvePackageDependencies", "-project", projectPath];
  const result = await xcodebuild(args);
  const packages = [];
  for (const line of result.stdout.split("\n")) {
    if (line.includes("resolved source packages")) {
      const pkg = line.match(/resolved source packages:\s*(.+)/);
      if (pkg && pkg[1]) packages.push(pkg[1].trim());
    }
  }
  return { packages, output: result.stdout };
}
async function archiveBuild(scheme, projectPath, exportOptions) {
  const tmpDir = await mkdtemp(join(tmpdir(), "xcode-mcp-archive-"));
  const archivePath = join(tmpDir, `${scheme}.xcarchive`);
  const archiveArgs = [
    "-project",
    projectPath,
    "-scheme",
    scheme,
    "-configuration",
    "Release",
    "-archivePath",
    archivePath,
    "archive"
  ];
  logger.info(`Archiving ${scheme} to ${archivePath}`);
  const archiveResult = await xcodebuild(archiveArgs, { timeout: 6e5 });
  const parsed = parseBuildOutput(archiveResult.stdout, archiveResult.stderr);
  if (!buildSucceeded(archiveResult.stdout)) {
    return { success: false, errors: parsed.errors, warnings: parsed.warnings };
  }
  if (!exportOptions) {
    return { success: true, archivePath, errors: [], warnings: parsed.warnings };
  }
  const exportPlist = join(tmpDir, "export-options.plist");
  const exportPath = join(tmpDir, "export");
  const plistContent = exportOptionsToPlist(exportOptions);
  await writeFile(exportPlist, plistContent, "utf-8");
  const exportArgs = [
    "-exportArchive",
    "-archivePath",
    archivePath,
    "-exportOptionsPlist",
    exportPlist,
    "-exportPath",
    exportPath
  ];
  const exportResult = await xcodebuild(exportArgs, { timeout: 6e5 });
  const exportParsed = parseBuildOutput(exportResult.stdout, exportResult.stderr);
  if (!buildSucceeded(exportResult.stdout)) {
    return { success: false, archivePath, errors: exportParsed.errors, warnings: [...parsed.warnings, ...exportParsed.warnings] };
  }
  return { success: true, archivePath, exportPath, errors: [], warnings: [...parsed.warnings, ...exportParsed.warnings] };
}
function exportOptionsToPlist(options) {
  let plist = '<?xml version="1.0" encoding="UTF-8"?>\n';
  plist += '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  plist += '<plist version="1.0">\n<dict>\n';
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string") {
      plist += `  <key>${escapePlistString(key)}</key>
  <string>${escapePlistString(value)}</string>
`;
    } else if (typeof value === "boolean") {
      plist += `  <key>${escapePlistString(key)}</key>
  <${value}/>
`;
    } else if (Array.isArray(value)) {
      plist += `  <key>${escapePlistString(key)}</key>
  <array>
`;
      for (const item of value) {
        plist += `    <string>${escapePlistString(String(item))}</string>
`;
      }
      plist += "  </array>\n";
    }
  }
  plist += "</dict>\n</plist>\n";
  return plist;
}
function escapePlistString(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
}
async function runAnalyze(scheme, target) {
  const args = ["analyze", "-scheme", scheme];
  if (target) args.push("-target", target);
  const result = await xcodebuild(args, { timeout: 6e5 });
  const parsed = parseBuildOutput(result.stdout, result.stderr);
  return { issues: [...parsed.errors, ...parsed.warnings], output: result.stdout + result.stderr };
}

export {
  killAllChildProcesses,
  xcrun,
  xcodebuild,
  parseBuildOutput,
  getBuildTime,
  buildSucceeded,
  buildFailedCheck,
  runBuild,
  getBuildSettings,
  resolvePackageDependencies,
  archiveBuild,
  runAnalyze
};
