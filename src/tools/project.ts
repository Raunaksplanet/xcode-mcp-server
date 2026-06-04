import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { XcodeMCPServer } from '../server.js';
import { getProjectInfo, getFileEntries } from '../lib/pbxproj_parser.js';
import { addFileToProject, removeFileFromProject, setBuildSetting } from '../lib/pbxproj_writer.js';
import { getBuildSettings } from '../lib/xcode_runner.js';
import { logger } from '../lib/logger.js';
import { pathTraversalDetected, fileNotFound } from '../lib/error_handler.js';

const execFileAsync = promisify(execFile);

function assertPathInProject(projectDir: string, filePath: string): string {
  const resolved = resolvePath(projectDir, filePath);
  if (!resolved.startsWith(projectDir)) {
    throw pathTraversalDetected(filePath);
  }
  return resolved;
}

export function registerProjectTools(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerTool({
    name: 'xcode_open_project',
    description: 'Open .xcodeproj or .xcworkspace in Xcode via osascript',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Path to .xcodeproj or .xcworkspace (defaults to XCODE_PROJECT_PATH)',
        },
      },
    },
    handler: async (args) => {
      const projectPath = (args.project_path as string) || config.projectPath;

      if (!existsSync(projectPath)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileNotFound(projectPath)) }],
          isError: true,
        };
      }

      const fullPath = resolvePath(projectPath);
      const escapedPath = fullPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const script = `
        tell application "Xcode"
          open "${escapedPath}"
          activate
        end tell
      `;

      try {
        await execFileAsync('osascript', ['-e', script]);
        logger.info(`Opened ${fullPath} in Xcode`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, path: fullPath }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'XCODE_OPEN_FAILED',
            message: `Failed to open project in Xcode: ${error instanceof Error ? error.message : String(error)}`,
            suggestion: 'Ensure Xcode is installed. Try: open -a Xcode',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_project_info',
    description: 'Get detailed information about the Xcode project',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Path to .xcodeproj (defaults to XCODE_PROJECT_PATH)',
        },
      },
    },
    handler: async (args) => {
      const projectPath = (args.project_path as string) || config.projectPath;
      const info = getProjectInfo(projectPath);
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_list_targets',
    description: 'List all targets in the Xcode project',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      return {
        content: [{ type: 'text', text: JSON.stringify(info.targets, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_list_schemes',
    description: 'List all schemes in the Xcode project',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      return {
        content: [{ type: 'text', text: JSON.stringify(info.schemes, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_list_files',
    description: 'List files in the project, optionally filtered by target or file type',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Filter by target name',
        },
        file_type: {
          type: 'string',
          description: 'Filter by file type (swift/objc/storyboard/xcassets/plist)',
          enum: ['swift', 'objc', 'storyboard', 'xcassets', 'plist', 'xib', 'strings', 'json', 'entitlements'],
        },
      },
    },
    handler: async (args) => {
      const targetName = args.target as string | undefined;
      const fileType = args.file_type as string | undefined;
      const entries = getFileEntries(config.projectPath, targetName);

      let filtered = entries;
      if (fileType) {
        filtered = entries.filter(e => e.type === fileType);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_add_file',
    description: 'Add a file to the Xcode project',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file (relative to project root)' },
        target: { type: 'string', description: 'Target name to add the file to' },
        content: { type: 'string', description: 'File content (creates file if it does not exist)' },
      },
      required: ['file_path', 'target'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const targetName = args.target as string;
      const content = args.content as string | undefined;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      if (!existsSync(resolvedPath) && content) {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname } = await import('node:path');
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, content, 'utf-8');
        logger.info(`Created file: ${resolvedPath}`);
      } else if (!existsSync(resolvedPath)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true,
        };
      }

      try {
        addFileToProject(config.projectPath, resolvedPath, targetName, content);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, file_path: filePath, target: targetName }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'ADD_FILE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Verify the target name exists and the file path is correct.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_remove_file',
    description: 'Remove a file from the Xcode project',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file (relative to project root)' },
        target: { type: 'string', description: 'Target name to remove the file from' },
        delete_from_disk: { type: 'boolean', description: 'Also delete the file from disk', default: false },
      },
      required: ['file_path', 'target'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const targetName = args.target as string;
      const deleteFromDisk = (args.delete_from_disk as boolean) || false;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      try {
        removeFileFromProject(config.projectPath, resolvedPath, targetName);

        if (deleteFromDisk && existsSync(resolvedPath)) {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(resolvedPath);
          logger.info(`Deleted file from disk: ${resolvedPath}`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, file_path: filePath, target: targetName, deleted_from_disk: deleteFromDisk }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'REMOVE_FILE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Verify the file exists in the project and the target name is correct.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_build_settings',
    description: 'Get resolved build settings for a target and configuration',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name' },
        configuration: { type: 'string', description: 'Build configuration (Debug/Release)', default: 'Release' },
      },
      required: ['target'],
    },
    handler: async (args) => {
      const target = args.target as string;
      const configuration = (args.configuration as string) || 'Release';

      try {
        const settings = await getBuildSettings(target, configuration);
        return {
          content: [{ type: 'text', text: JSON.stringify(settings, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'BUILD_SETTINGS_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the target and configuration names are correct.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_set_build_setting',
    description: 'Set a build setting in the Xcode project for a target and configuration',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name' },
        configuration: { type: 'string', description: 'Build configuration (Debug/Release)' },
        key: { type: 'string', description: 'Build setting key (e.g., PRODUCT_BUNDLE_IDENTIFIER)' },
        value: { type: 'string', description: 'Build setting value' },
      },
      required: ['target', 'configuration', 'key', 'value'],
    },
    handler: async (args) => {
      const target = args.target as string;
      const configuration = args.configuration as string;
      const key = args.key as string;
      const value = args.value as string;

      try {
        setBuildSetting(config.projectPath, target, configuration, key, value);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, target, configuration, key, value }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SET_SETTING_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Verify the target and configuration exist in the project.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_resolve_packages',
    description: 'Resolve Swift Package Manager dependencies',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      try {
        const { resolvePackageDependencies } = await import('../lib/xcode_runner.js');
        const result = await resolvePackageDependencies(config.projectPath);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'RESOLVE_PACKAGES_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Check your network connection and Package.swift files.',
          }) }],
          isError: true,
        };
      }
    },
  });
}
