import type { XcodeMCPServer } from '../server.js';
import { runBuild, archiveBuild, runAnalyze, parseBuildOutput } from '../lib/xcode_runner.js';
import { logger } from '../lib/logger.js';
import { buildFailed } from '../lib/error_handler.js';

export function registerBuildTools(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerTool({
    name: 'xcode_build',
    description: 'Build the Xcode project using xcodebuild',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to build (defaults to XCODE_DEFAULT_SCHEME)',
        },
        configuration: {
          type: 'string',
          description: 'Build configuration (Debug/Release)',
          default: 'Debug',
        },
        destination: {
          type: 'string',
          description: 'Build destination (e.g., "platform=iOS Simulator,name=iPhone 16")',
        },
        clean: {
          type: 'boolean',
          description: 'Clean build',
          default: false,
        },
        derived_data_path: {
          type: 'string',
          description: 'Custom DerivedData path',
        },
      },
    },
    handler: async (args) => {
      const scheme = (args.scheme as string) || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'NO_SCHEME',
            message: 'No scheme specified and XCODE_DEFAULT_SCHEME is not set',
            suggestion: 'Pass a scheme argument or set XCODE_DEFAULT_SCHEME in your environment.',
          }) }],
          isError: true,
        };
      }

      const dest = (args.destination as string) || config.projectConfig.custom_destinations?.[0];

      try {
        const result = await runBuild({
          scheme,
          configuration: (args.configuration as string) || 'Debug',
          destination: dest,
          clean: (args.clean as boolean) || false,
          derivedDataPath: (args.derived_data_path as string) || config.derivedDataPath,
          timeout: config.buildTimeout * 1000,
          onProgress: (line) => {
            logger.info(`[build] ${line}`);
          },
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ...buildFailed(error instanceof Error ? error.message : String(error)),
            scheme,
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_build_for_testing',
    description: 'Build the project for testing (xcodebuild build-for-testing)',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to build for testing',
        },
        destination: {
          type: 'string',
          description: 'Test destination',
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
        const { xcodebuild } = await import('../lib/xcode_runner.js');
        const buildArgs = [
          '-scheme', scheme,
          '-project', config.projectPath,
          '-destination', (args.destination as string) || 'platform=iOS Simulator,name=iPhone 16',
          'build-for-testing',
        ];

        const result = await xcodebuild(buildArgs, {
          timeout: config.buildTimeout * 1000,
          onProgress: (line) => logger.info(`[build-for-testing] ${line}`),
        });

        const parsed = parseBuildOutput(result.stdout, result.stderr);
        const success = result.stdout.includes('BUILD SUCCEEDED');

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success,
            scheme,
            errors: parsed.errors,
            warnings: parsed.warnings,
            output: result.stdout.slice(-2000),
          }, null, 2) }],
          isError: !success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_archive',
    description: 'Build an archive of the project for distribution',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to archive',
        },
        export_options: {
          type: 'object',
          description: 'Export options (method, teamID, etc.)',
          properties: {
            method: { type: 'string', description: 'Export method (app-store/ad-hoc/development/enterprise)' },
            teamID: { type: 'string', description: 'Team ID for signing' },
            signingStyle: { type: 'string', description: 'automatic/manual' },
          },
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
        const exportOptions = args.export_options as Record<string, unknown> | undefined;
        const result = await archiveBuild(scheme, config.projectPath, exportOptions);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_clean',
    description: 'Clean the Xcode build directory',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to clean (optional)',
        },
        derived_data: {
          type: 'boolean',
          description: 'Also wipe DerivedData',
          default: false,
        },
      },
    },
    handler: async (args) => {
      const results: string[] = [];

      try {
        const { xcodebuild } = await import('../lib/xcode_runner.js');
        const cleanArgs = ['clean'];
        const scheme = (args.scheme as string) || config.defaultScheme;
        if (scheme) cleanArgs.push('-scheme', scheme);
        cleanArgs.push('-project', config.projectPath);

        const result = await xcodebuild(cleanArgs, { timeout: 120000 });
        results.push(result.stdout.includes('CLEAN SUCCEEDED') ? 'Clean succeeded' : 'Clean may have had issues');

        if (args.derived_data) {
          const { execSync } = await import('node:child_process');
          execSync('rm -rf ~/Library/Developer/Xcode/DerivedData/*', { stdio: 'pipe' });
          results.push('DerivedData wiped');
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, results }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_build_errors',
    description: 'Get parsed errors and warnings from the most recent build',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');

      const derivedData = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');

      try {
        const dirs = readdirSync(derivedData);
        const projectName = config.projectPath.split('/').pop()?.replace(/\.xcodeproj$/, '') || '';
        const matchingDir = dirs.find(d => d.startsWith(projectName));

        if (!matchingDir) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              errors: [],
              warnings: [],
              message: 'No DerivedData found for this project. Build the project first.',
            }, null, 2) }],
          };
        }

        const buildLogDir = join(derivedData, matchingDir, 'Logs', 'Build');
        const logFiles = readdirSync(buildLogDir)
          .filter(f => f.endsWith('.xcactivitylog'))
          .map(f => ({ name: f, time: statSync(join(buildLogDir, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time);

        if (logFiles.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ errors: [], warnings: [], message: 'No build logs found.' }) }],
          };
        }

        const latestLog = readFileSync(join(buildLogDir, logFiles[0]!.name), 'utf-8');
        const parsed = parseBuildOutput(latestLog, '');

        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            errors: [],
            warnings: [],
            message: `Could not read build logs: ${error instanceof Error ? error.message : String(error)}`,
          }, null, 2) }],
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_analyzer_results',
    description: 'Run the static analyzer and return issues',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to analyze',
        },
        target: {
          type: 'string',
          description: 'Optional target to analyze',
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
        const result = await runAnalyze(scheme, args.target as string | undefined);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true,
        };
      }
    },
  });
}
