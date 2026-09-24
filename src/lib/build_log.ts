import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { gunzipSync } from 'node:zlib';

/** Cap on how much log text we ever decode (binary logs can be huge). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LatestBuildLog {
  found: boolean;
  /** Decoded tail of the newest log (at most MAX_LOG_BYTES). Empty when !found. */
  log: string;
  /** Human-readable reason when !found (safe to show to clients). */
  reason?: string;
  /** True when the log was truncated to the cap. */
  truncated?: boolean;
}

function derivedDataRoot(): string | undefined {
  const root = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  try {
    if (existsSync(root)) return root;
  } catch {
    // Unreadable home — treat as missing.
  }
  return undefined;
}

/** Find this project's DerivedData dir (exact base name or base-<hash>). */
export function findProjectDerivedData(projectPath: string): string | undefined {
  const root = derivedDataRoot();
  if (!root) return undefined;
  const base = basename(projectPath).replace(/\.(xcodeproj|xcworkspace)$/, '');
  if (!base) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const match = entries.find((d) => d === base || d.startsWith(`${base}-`));
  return match ? join(root, match) : undefined;
}

function newestFile(dir: string, suffix: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((f) => f.endsWith(suffix))
    .map((f) => {
      try {
        return { name: f, time: statSync(join(dir, f)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((e): e is { name: string; time: number } => e !== undefined)
    .sort((a, b) => b.time - a.time);
  return candidates.length > 0 ? join(dir, candidates[0]!.name) : undefined;
}

function decodeMaybeGzipped(raw: Buffer): { text: string; truncated: boolean } {
  let bytes = raw;
  // .xcactivitylog files are gzipped binaries: gunzip before decoding.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return { text: '', truncated: false };
    }
  }
  const truncated = bytes.length > MAX_LOG_BYTES;
  if (truncated) bytes = bytes.subarray(bytes.length - MAX_LOG_BYTES);
  return { text: bytes.toString('utf-8'), truncated };
}

/** Read the newest build log for a project, handling missing dirs and gzip. */
export function readLatestBuildLog(projectPath: string): LatestBuildLog {
  const projectDir = findProjectDerivedData(projectPath);
  if (!projectDir) {
    return { found: false, log: '', reason: 'No DerivedData found for this project. Build the project first.' };
  }
  const buildLogDir = join(projectDir, 'Logs', 'Build');
  if (!existsSync(buildLogDir)) {
    return { found: false, log: '', reason: 'No build logs found. Build the project first.' };
  }
  const latest = newestFile(buildLogDir, '.xcactivitylog');
  if (!latest) {
    return { found: false, log: '', reason: 'No build logs found.' };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(latest);
  } catch (err) {
    return { found: false, log: '', reason: `Could not read build log: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { text, truncated } = decodeMaybeGzipped(raw);
  return { found: true, log: text, truncated };
}

/** Find the newest .xcresult bundle under DerivedData/<project>/Logs/Test. */
export function findLatestXcresult(projectPath: string): string | undefined {
  const projectDir = findProjectDerivedData(projectPath);
  if (!projectDir) return undefined;
  const testLogsDir = join(projectDir, 'Logs', 'Test');
  if (!existsSync(testLogsDir)) return undefined;
  return newestFile(testLogsDir, '.xcresult');
}
