import { existsSync, readdirSync } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { resolve as resolvePath, join } from 'node:path';
import { logger } from './logger.js';
import { parseTimeoutEnv } from './validation.js';

export interface XcodeMCPConfig {
  projectPath: string;
  defaultScheme?: string;
  defaultSimulator?: string;
  derivedDataPath?: string;
  buildTimeout: number;
  testTimeout: number;
  logLevel: string;
}

export interface ProjectConfig {
  default_scheme?: string;
  default_simulator?: string;
  excluded_paths?: string[];
  build_pre_hooks?: string[];
  build_post_hooks?: string[];
  custom_destinations?: string[];
}

function validateProjectPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error('XCODE_PROJECT_PATH is empty.\nSet it to the path of your .xcodeproj or .xcworkspace.');
  }
  const resolved = resolvePath(trimmed);
  if (!existsSync(resolved)) {
    // If the user pointed at a directory containing a .xcodeproj/.xcworkspace, resolve it.
    try {
      const stat = readdirSync(resolved);
      const candidate = stat.find((f) => f.endsWith('.xcworkspace') || f.endsWith('.xcodeproj'));
      if (candidate) {
        const full = join(resolved, candidate);
        logger.info(`Resolved project directory to ${full}`);
        return full;
      }
    } catch {
      // Not a readable directory — fall through to the not-found error.
    }
    throw new Error(
      `XCODE_PROJECT_PATH not found at: ${resolved}\n` +
      `Set the correct path in your environment or .env file.\n` +
      `Expected a .xcodeproj or .xcworkspace directory.`
    );
  }
  const isValid =
    resolved.endsWith('.xcodeproj') ||
    resolved.endsWith('.xcworkspace') ||
    existsSync(join(resolved, 'project.pbxproj'));

  if (!isValid) {
    throw new Error(
      `Path is not a valid Xcode project: ${resolved}\n` +
      `XCODE_PROJECT_PATH must point to a .xcodeproj or .xcworkspace directory.`
    );
  }
  return resolved;
}

async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  const configPath = join(projectDir, '.xcode-mcp.json');
  try {
    await access(configPath);
    const content = await readFile(configPath, 'utf-8');
    try {
      const parsed = JSON.parse(content) as ProjectConfig;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        logger.warn(`Ignoring ${configPath}: expected a JSON object.`);
        return {};
      }
      return parsed;
    } catch (parseError) {
      logger.warn(`Ignoring ${configPath}: invalid JSON (${parseError instanceof Error ? parseError.message : String(parseError)}).`);
      return {};
    }
  } catch {
    return {};
  }
}

export interface ResolvedConfig {
  projectPath: string;
  projectDir: string;
  defaultScheme: string;
  defaultSimulator?: string;
  derivedDataPath?: string;
  buildTimeout: number;
  testTimeout: number;
  projectConfig: ProjectConfig;
}

export async function loadConfig(): Promise<ResolvedConfig> {
  const projectPathRaw = process.env.XCODE_PROJECT_PATH;
  if (!projectPathRaw) {
    throw new Error(
      'XCODE_PROJECT_PATH environment variable is required.\n' +
      'Set it to the path of your .xcodeproj or .xcworkspace, e.g.:\n' +
      '  export XCODE_PROJECT_PATH=/path/to/YourApp.xcodeproj\n' +
      'Or create an .env file and set it there.'
    );
  }

  const projectPath = validateProjectPath(projectPathRaw);
  const projectDir = projectPath.endsWith('.xcodeproj') || projectPath.endsWith('.xcworkspace')
    ? resolvePath(projectPath, '..')
    : projectPath;

  const projectConfig = await loadProjectConfig(projectDir);

  const defaultScheme =
    process.env.XCODE_DEFAULT_SCHEME?.trim() ||
    projectConfig.default_scheme?.trim();

  if (!defaultScheme) {
    logger.warn('No default scheme configured. Set XCODE_DEFAULT_SCHEME or add default_scheme to .xcode-mcp.json');
  }

  const derivedDataPath = process.env.XCODE_DERIVED_DATA_PATH?.trim() || undefined;

  // Validate optional simulator identifier (UDID or name) — warn but don't fail.
  const defaultSimulator = process.env.XCODE_DEFAULT_SIMULATOR?.trim() || projectConfig.default_simulator?.trim();
  if (defaultSimulator && defaultSimulator.length > 256) {
    logger.warn('Ignoring XCODE_DEFAULT_SIMULATOR: value exceeds 256 characters.');
  }

  return {
    projectPath,
    projectDir,
    defaultScheme: defaultScheme || '',
    defaultSimulator: defaultSimulator && defaultSimulator.length <= 256 ? defaultSimulator : undefined,
    derivedDataPath,
    buildTimeout: parseTimeoutEnv(process.env.XCODE_MCP_BUILD_TIMEOUT, 300),
    testTimeout: parseTimeoutEnv(process.env.XCODE_MCP_TEST_TIMEOUT, 600),
    projectConfig,
  };
}
