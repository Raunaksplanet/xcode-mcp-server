import { existsSync } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { resolve as resolvePath, join } from 'node:path';
import { logger } from './logger.js';

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
  const resolved = resolvePath(rawPath);
  if (!existsSync(resolved)) {
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
    return JSON.parse(content) as ProjectConfig;
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
    process.env.XCODE_DEFAULT_SCHEME ||
    projectConfig.default_scheme;

  if (!defaultScheme) {
    logger.warn('No default scheme configured. Set XCODE_DEFAULT_SCHEME or add default_scheme to .xcode-mcp.json');
  }

  return {
    projectPath,
    projectDir,
    defaultScheme: defaultScheme || '',
    defaultSimulator: process.env.XCODE_DEFAULT_SIMULATOR || projectConfig.default_simulator,
    derivedDataPath: process.env.XCODE_DERIVED_DATA_PATH,
    buildTimeout: parseInt(process.env.XCODE_MCP_BUILD_TIMEOUT || '300', 10),
    testTimeout: parseInt(process.env.XCODE_MCP_TEST_TIMEOUT || '600', 10),
    projectConfig,
  };
}
