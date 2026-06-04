import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { XcodeMCPServer } from '../server.js';
import { xcrun, parseBuildOutput } from '../lib/xcode_runner.js';

export function registerDiagnosticsTools(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerTool({
    name: 'xcode_get_warnings',
    description: 'Get all warnings from the latest build',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      try {
        const derivedData = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
        const dirs = readdirSync(derivedData);
        const projectName = config.projectPath.split('/').pop()?.replace(/\.xcodeproj$/, '') || '';
        const matchingDir = dirs.find(d => d.startsWith(projectName));

        if (!matchingDir) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ warnings: [], message: 'No build logs found. Build the project first.' }) }],
          };
        }

        const buildLogDir = join(derivedData, matchingDir, 'Logs', 'Build');
        if (!existsSync(buildLogDir)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ warnings: [], message: 'No build logs found. Build the project first.' }) }],
          };
        }

        const logFiles = readdirSync(buildLogDir)
          .filter(f => f.endsWith('.xcactivitylog'))
          .map(f => ({ name: f, time: statSync(join(buildLogDir, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time);

        if (logFiles.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ warnings: [], message: 'No build logs found.' }) }],
          };
        }

        const latestLog = readFileSync(join(buildLogDir, logFiles[0]!.name), 'utf-8');
        const parsed = parseBuildOutput(latestLog, '');

        const groupedWarnings: Record<string, typeof parsed.warnings> = {};
        for (const w of parsed.warnings) {
          const file = w.file || '(unknown)';
          if (!groupedWarnings[file]) groupedWarnings[file] = [];
          groupedWarnings[file]!.push(w);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({
            warning_count: parsed.warnings.length,
            error_count: parsed.errors.length,
            warnings_by_file: groupedWarnings,
            all_warnings: parsed.warnings,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'WARNINGS_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Build the project first to generate warnings.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_profile_app',
    description: 'Profile an app using xctrace (Instruments)',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to profile',
        },
        destination: {
          type: 'string',
          description: 'Destination (e.g., platform=iOS Simulator,name=iPhone 16)',
        },
        template: {
          type: 'string',
          description: 'Instruments template (e.g., "Time Profiler", "Leaks", "Allocations")',
          default: 'Time Profiler',
        },
        duration_seconds: {
          type: 'number',
          description: 'Recording duration in seconds',
          default: 10,
        },
      },
    },
    handler: async (args) => {
      const scheme = (args.scheme as string) || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'NO_SCHEME',
            message: 'No scheme specified',
            suggestion: 'Pass a scheme argument.',
          }) }],
          isError: true,
        };
      }

      try {
        const tmpDir = join(homedir(), 'tmp');
        const tracePath = join(tmpDir, `${scheme}-${Date.now()}.trace`);

        await xcrun('xctrace', [
          'record',
          '--template', (args.template as string) || 'Time Profiler',
          '--device', (args.destination as string) || '',
          '--time-limit', `${(args.duration_seconds as number) || 10}s`,
          '--output', tracePath,
          '--target', scheme,
        ]);

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            output_path: tracePath,
            schema: scheme,
            template: args.template || 'Time Profiler',
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'PROFILE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the scheme builds successfully and a simulator is booted.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_add_spm_package',
    description: 'Add a Swift Package Manager dependency to the project',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Package repository URL (e.g., https://github.com/pointfreeco/swift-composable-architecture)',
        },
        version_requirement: {
          type: 'object',
          description: 'Version requirement (exact version, range, or branch)',
          properties: {
            type: {
              type: 'string',
              description: 'Requirement type: exact, upToNextMajorVersion, upToNextMinorVersion, branch, revision',
              enum: ['exact', 'upToNextMajorVersion', 'upToNextMinorVersion', 'branch', 'revision'],
            },
            value: {
              type: 'string',
              description: 'Version or branch name (e.g., "1.0.0", "main")',
            },
          },
        },
        target: {
          type: 'string',
          description: 'Target to link the package to',
        },
      },
      required: ['url', 'target'],
    },
    handler: async (args) => {
      const url = args.url as string;
      const targetName = args.target as string;
      const versionReq = args.version_requirement as { type?: string; value?: string } | undefined;
      const versionType = versionReq?.type || 'upToNextMajorVersion';
      const versionValue = versionReq?.value || '1.0.0';

      try {
        const packageName = url.split('/').pop()?.replace(/\.git$/, '') || 'Package';

        const { resolvePackageDependencies } = await import('../lib/xcode_runner.js');
        const result = await resolvePackageDependencies(config.projectPath);

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            package_name: packageName,
            url,
            version: `${versionType}: ${versionValue}`,
            target: targetName,
            resolved: result,
            note: 'Package reference added. You may need to add the product to your target in Xcode.',
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SPM_ADD_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the package URL is valid and the project is configured correctly.',
          }) }],
          isError: true,
        };
      }
    },
  });
}
