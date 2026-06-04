import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExec } from './process_manager.js';
import { logger } from './logger.js';
import type { BuildIssue, BuildResult, BuildSettings } from '../types/xcodebuild.js';

interface XCRunOptions {
  timeout?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

interface XcodeBuildOptions {
  scheme?: string;
  configuration?: string;
  destination?: string;
  clean?: boolean;
  derivedDataPath?: string;
  timeout?: number;
  onProgress?: (line: string) => void;
  xcargs?: string[];
}

function sanitizeArgs(args: string[]): string[] {
  return args.map(a => {
    if (a.includes('$') || a.includes('`') || a.includes(';') || a.includes('|')) {
      return a.replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/;/g, '\\;').replace(/\|/g, '\\|');
    }
    return a;
  });
}

export async function xcrun(command: string, args: string[], options: XCRunOptions = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const allArgs = sanitizeArgs([command, ...args]);
  return createExec('xcrun', allArgs, {
    timeout: options.timeout,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
}

export async function xcodebuild(args: string[], options: XcodeBuildOptions = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const allArgs = sanitizeArgs(args);
  return createExec('xcodebuild', allArgs, {
    timeout: options.timeout,
    onStdout: options.onProgress || options.onProgress,
    onStderr: options.onProgress || options.onProgress,
  });
}

export function parseBuildOutput(stdout: string, stderr: string): { errors: BuildIssue[]; warnings: BuildIssue[] } {
  const errors: BuildIssue[] = [];
  const warnings: BuildIssue[] = [];
  const lines = (stdout + '\n' + stderr).split('\n');

  for (const line of lines) {
    const errorMatch = line.match(/^(?:(.+?):(\d+):(?:\d+)?:\s*)?error:\s*(.+)$/);
    if (errorMatch) {
      errors.push({
        type: 'error',
        file: errorMatch[1],
        line: errorMatch[2] ? parseInt(errorMatch[2], 10) : undefined,
        message: errorMatch[3]?.trim() || '',
      });
      continue;
    }

    const warningMatch = line.match(/^(?:(.+?):(\d+):(?:\d+)?:\s*)?warning:\s*(.+)$/);
    if (warningMatch) {
      warnings.push({
        type: 'warning',
        file: warningMatch[1],
        line: warningMatch[2] ? parseInt(warningMatch[2], 10) : undefined,
        message: warningMatch[3]?.trim() || '',
      });
      continue;
    }

    const fixItMatch = line.match(/^\s*fix-it:\s*(.+?):(\d+):(\d+):\s*(.+)$/);
    if (fixItMatch) {
      if (errors.length > 0) {
        errors[errors.length - 1]!.fixIt = fixItMatch[0];
      }
      continue;
    }

    const noteMatch = line.match(/^(?:(.+?):(\d+):(?:\d+)?:\s*)?note:\s*(.+)$/);
    if (noteMatch) {
      errors.push({
        type: 'note',
        file: noteMatch[1],
        line: noteMatch[2] ? parseInt(noteMatch[2], 10) : undefined,
        message: noteMatch[3]?.trim() || '',
      });
    }
  }

  return { errors, warnings };
}

export function getBuildTime(stdout: string): number {
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

export function buildSucceeded(stdout: string): boolean {
  return stdout.includes('BUILD SUCCEEDED');
}

export function buildFailedCheck(stdout: string): boolean {
  return stdout.includes('BUILD FAILED');
}

export async function runBuild(options: XcodeBuildOptions): Promise<BuildResult> {
  const args: string[] = [];

  if (options.clean) {
    args.push('clean');
  }

  args.push('build');

  if (options.scheme) {
    args.push('-scheme', options.scheme);
  }

  if (options.configuration) {
    args.push('-configuration', options.configuration);
  }

  if (options.destination) {
    args.push('-destination', options.destination);
  }

  if (options.derivedDataPath) {
    args.push('-derivedDataPath', options.derivedDataPath);
  }

  if (options.xcargs) {
    args.push(...options.xcargs);
  }

  const startTime = Date.now();
  const progressLog: string[] = [];

  const result = await xcodebuild(args, {
    timeout: options.timeout,
    onProgress: (line: string) => {
      progressLog.push(line);
      if (options.onProgress) options.onProgress(line);
    },
  });

  const buildTime = (Date.now() - startTime) / 1000;
  const combinedOutput = result.stdout + '\n' + result.stderr;
  const fullLog = progressLog.join('\n') || combinedOutput;

  const parsed = parseBuildOutput(result.stdout, result.stderr);

  const success = buildSucceeded(result.stdout);

  if (!success) {
    logger.error('Build failed:', result.stderr.slice(0, 500));
  } else {
    const time = getBuildTime(result.stdout) || buildTime;
    logger.info(`Build succeeded in ${time.toFixed(1)}s`);
  }

  return {
    success,
    scheme: options.scheme || '',
    configuration: options.configuration || 'Debug',
    destination: options.destination,
    buildTimeSeconds: getBuildTime(result.stdout) || buildTime,
    errors: parsed.errors,
    warnings: parsed.warnings,
    outputLog: fullLog,
  };
}

export async function getBuildSettings(target: string, configuration: string): Promise<BuildSettings> {
  const args = ['-showBuildSettings', '-target', target, '-configuration', configuration];
  const result = await xcodebuild(args);
  const settings: BuildSettings = {};

  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s+(\S+)\s+=\s+(.+)$/);
    if (match && match[1] && match[2]) {
      settings[match[1]] = match[2].trim();
    }
  }

  return settings;
}

export async function resolvePackageDependencies(projectPath: string): Promise<{ packages: string[]; output: string }> {
  const args = ['-resolvePackageDependencies', '-project', projectPath];
  const result = await xcodebuild(args);
  const packages: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.includes('resolved source packages')) {
      const pkg = line.match(/resolved source packages:\s*(.+)/);
      if (pkg && pkg[1]) packages.push(pkg[1].trim());
    }
  }
  return { packages, output: result.stdout };
}

export async function archiveBuild(
  scheme: string,
  projectPath: string,
  exportOptions?: Record<string, unknown>
): Promise<{ archivePath?: string; exportPath?: string; success: boolean; errors: BuildIssue[]; warnings: BuildIssue[] }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'xcode-mcp-archive-'));
  const archivePath = join(tmpDir, `${scheme}.xcarchive`);

  const archiveArgs = [
    '-project', projectPath,
    '-scheme', scheme,
    '-configuration', 'Release',
    '-archivePath', archivePath,
    'archive',
  ];

  logger.info(`Archiving ${scheme} to ${archivePath}`);
  const archiveResult = await xcodebuild(archiveArgs, { timeout: 600000 });
  const parsed = parseBuildOutput(archiveResult.stdout, archiveResult.stderr);

  if (!buildSucceeded(archiveResult.stdout)) {
    return { success: false, errors: parsed.errors, warnings: parsed.warnings };
  }

  if (!exportOptions) {
    return { success: true, archivePath, errors: [], warnings: parsed.warnings };
  }

  const exportPlist = join(tmpDir, 'export-options.plist');
  const exportPath = join(tmpDir, 'export');

  const plistContent = exportOptionsToPlist(exportOptions);
  await writeFile(exportPlist, plistContent, 'utf-8');

  const exportArgs = [
    '-exportArchive',
    '-archivePath', archivePath,
    '-exportOptionsPlist', exportPlist,
    '-exportPath', exportPath,
  ];

  const exportResult = await xcodebuild(exportArgs, { timeout: 600000 });
  const exportParsed = parseBuildOutput(exportResult.stdout, exportResult.stderr);

  if (!buildSucceeded(exportResult.stdout)) {
    return { success: false, archivePath, errors: exportParsed.errors, warnings: [...parsed.warnings, ...exportParsed.warnings] };
  }

  return { success: true, archivePath, exportPath, errors: [], warnings: [...parsed.warnings, ...exportParsed.warnings] };
}

function exportOptionsToPlist(options: Record<string, unknown>): string {
  let plist = '<?xml version="1.0" encoding="UTF-8"?>\n';
  plist += '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  plist += '<plist version="1.0">\n<dict>\n';
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string') {
      plist += `  <key>${escapePlistString(key)}</key>\n  <string>${escapePlistString(value)}</string>\n`;
    } else if (typeof value === 'boolean') {
      plist += `  <key>${escapePlistString(key)}</key>\n  <${value}/>\n`;
    } else if (Array.isArray(value)) {
      plist += `  <key>${escapePlistString(key)}</key>\n  <array>\n`;
      for (const item of value) {
        plist += `    <string>${escapePlistString(String(item))}</string>\n`;
      }
      plist += '  </array>\n';
    }
  }
  plist += '</dict>\n</plist>\n';
  return plist;
}

function escapePlistString(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}

export async function runAnalyze(scheme: string, target?: string): Promise<{ issues: BuildIssue[]; output: string }> {
  const args = ['analyze', '-scheme', scheme];
  if (target) args.push('-target', target);
  const result = await xcodebuild(args, { timeout: 600000 });
  const parsed = parseBuildOutput(result.stdout, result.stderr);
  return { issues: [...parsed.errors, ...parsed.warnings], output: result.stdout + result.stderr };
}
