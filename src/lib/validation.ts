import { resolve as resolvePath, sep } from 'node:path';
import { pathTraversalDetected, invalidInput } from './error_handler.js';

/**
 * Securely resolve a user-supplied path against the project directory.
 * Rejects absolute paths escaping the project, `..` traversal, and
 * prefix-confusion attacks (e.g. `/proj-evil` vs `/proj`).
 */
export function assertPathInProject(projectDir: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw invalidInput('file_path', 'Path must be a non-empty string.');
  }
  if (filePath.length > 1024) {
    throw invalidInput('file_path', 'Path exceeds maximum length of 1024 characters.');
  }
  if (filePath.includes('\0')) {
    throw invalidInput('file_path', 'Path must not contain null bytes.');
  }

  const base = resolvePath(projectDir);
  const resolved = resolvePath(base, filePath);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw pathTraversalDetected(filePath);
  }
  return resolved;
}

/** Throw INVALID_INPUT when `value` is not a non-empty string. Returns trimmed value. */
export function requireNonEmptyString(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== 'string') {
    throw invalidInput(field, `Expected a string, got ${value === null ? 'null' : typeof value}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidInput(field, 'Must be a non-empty string.');
  }
  if (trimmed.length > maxLength) {
    throw invalidInput(field, `Exceeds maximum length of ${maxLength} characters.`);
  }
  return trimmed;
}

/** Return trimmed string or undefined when missing/empty. Validates length. */
export function optionalString(value: unknown, field: string, maxLength = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw invalidInput(field, `Expected a string, got ${typeof value}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw invalidInput(field, `Exceeds maximum length of ${maxLength} characters.`);
  }
  return trimmed;
}

const UDID_RE = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i;

/** Simulator UDIDs are strict UUIDs; names are also accepted by most tools. */
export function isValidUdid(value: string): boolean {
  return UDID_RE.test(value);
}

export function requireUdidOrName(value: unknown, field = 'udid'): string {
  const s = requireNonEmptyString(value, field, 256);
  // Accept full UDIDs or human-readable device names (letters, numbers, spaces, -, _, (), .).
  if (isValidUdid(s)) return s;
  if (/^[\w\s\-_().+]+$/.test(s)) return s;
  throw invalidInput(field, 'Must be a simulator UDID or device name.');
}

const BUNDLE_ID_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

export function requireBundleId(value: unknown, field = 'bundle_id'): string {
  const s = requireNonEmptyString(value, field, 256);
  if (!BUNDLE_ID_RE.test(s)) {
    throw invalidInput(field, 'Must be a valid reverse-DNS bundle identifier (e.g. com.example.App).');
  }
  return s;
}

export function requireUrl(value: unknown, field = 'url'): string {
  const s = requireNonEmptyString(value, field, 2048);
  try {
    const parsed = new URL(s);
    if (!['http:', 'https:', 'ftp:', 'file:'].includes(parsed.protocol) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(parsed.protocol)) {
      throw invalidInput(field, 'URL must include a valid scheme (e.g. myapp://deep-link).');
    }
    void parsed;
    return s;
  } catch (err) {
    // Allow custom schemes like myapp:// which URL() accepts; only reject truly malformed input.
    if (err && typeof err === 'object' && 'code' in (err as Record<string, unknown>) && (err as Record<string, unknown>).code === 'INVALID_INPUT') {
      throw err;
    }
    throw invalidInput(field, 'Must be a valid URL (e.g. myapp://path or https://example.com).');
  }
}

export function requireLatitude(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput('latitude', 'Must be a finite number between -90 and 90.');
  }
  if (value < -90 || value > 90) {
    throw invalidInput('latitude', 'Must be between -90 and 90.');
  }
  return value;
}

export function requireLongitude(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput('longitude', 'Must be a finite number between -180 and 180.');
  }
  if (value < -180 || value > 180) {
    throw invalidInput('longitude', 'Must be between -180 and 180.');
  }
  return value;
}

/** Clamp line-count style inputs to a sane range. */
export function clampLines(value: unknown, defaultValue: number, max = 5000): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput('lines', 'Must be a number.');
  }
  const n = Math.floor(value);
  if (n < 1) throw invalidInput('lines', 'Must be >= 1.');
  if (n > max) throw invalidInput('lines', `Must be <= ${max}.`);
  return n;
}

export function clampDurationSeconds(value: unknown, defaultValue: number, max = 600): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput('duration_seconds', 'Must be a number.');
  }
  const n = Math.floor(value);
  if (n < 1) throw invalidInput('duration_seconds', 'Must be >= 1 second.');
  if (n > max) throw invalidInput('duration_seconds', `Must be <= ${max} seconds.`);
  return n;
}

/** Parse a timeout env var (seconds) with fallback + range guard. */
export function parseTimeoutEnv(raw: string | undefined, fallbackSeconds: number, min = 1, max = 7200): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallbackSeconds;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallbackSeconds;
  if (n < min || n > max) return fallbackSeconds;
  return n;
}

/** Returns `['-project' | '-workspace', path]` so callers handle both project types. */
export function projectFlag(projectPath: string): ['-project' | '-workspace', string] {
  if (projectPath.endsWith('.xcworkspace')) return ['-workspace', projectPath];
  return ['-project', projectPath];
}

/** Validate an APNs-ish payload: must be a non-null object with string keys. */
export function requirePayloadObject(value: unknown, field = 'payload'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidInput(field, 'Must be a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    throw invalidInput(field, 'Must not be an empty object.');
  }
  if (keys.length > 100) {
    throw invalidInput(field, 'Too many keys (max 100).');
  }
  const serialized = JSON.stringify(obj);
  if (serialized.length > 64 * 1024) {
    throw invalidInput(field, 'Payload exceeds 64KB.');
  }
  return obj;
}

/** Validate a scheme name (alphanumeric + spaces, dashes, underscores, dots). */
export function requireSchemeName(value: unknown, field = 'scheme'): string {
  const s = requireNonEmptyString(value, field, 256);
  if (!/^[\w\s\-_().+]+$/.test(s)) {
    throw invalidInput(field, 'Contains invalid characters for a scheme name.');
  }
  return s;
}

/** Validate an Xcode target name. */
export function requireTargetName(value: unknown, field = 'target'): string {
  const s = requireNonEmptyString(value, field, 256);
  if (!/^[\w\s\-_().+]+$/.test(s)) {
    throw invalidInput(field, 'Contains invalid characters for a target name.');
  }
  return s;
}

/** Validate a build configuration name. */
export function requireConfigurationName(value: unknown, field = 'configuration'): string {
  const s = requireNonEmptyString(value, field, 64);
  if (!/^[A-Za-z0-9_\- ]+$/.test(s)) {
    throw invalidInput(field, 'Must contain only letters, numbers, spaces, dashes and underscores.');
  }
  return s;
}

/** Validate a build-setting key (e.g. PRODUCT_BUNDLE_IDENTIFIER). */
export function requireBuildSettingKey(value: unknown): string {
  const s = requireNonEmptyString(value, 'key', 128);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(s)) {
    throw invalidInput('key', 'Must be an uppercase Xcode build setting key (e.g. PRODUCT_BUNDLE_IDENTIFIER).');
  }
  return s;
}
