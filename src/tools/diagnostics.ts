import type { XcodeMCPServer } from '../server.js';
import { xcrun, parseBuildOutput } from '../lib/xcode_runner.js';
import { readLatestBuildLog } from '../lib/build_log.js';
import { requireSchemeName, optionalString, clampDurationSeconds } from '../lib/validation.js';

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
        const latest = readLatestBuildLog(config.projectPath);
        if (!latest.found) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ warnings: [], message: latest.reason || 'No build logs found.' }) }],
          };
        }
        const parsed = parseBuildOutput(latest.log, '');

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
      const scheme = requireSchemeName((args.scheme as string) || config.defaultScheme, 'scheme');
      const template = optionalString(args.template, 'template', 128) || 'Time Profiler';
      const durationSeconds = clampDurationSeconds(args.duration_seconds, 10, 300);
      const destinationRaw = optionalString(args.destination, 'destination', 256);

      try {
        const { findSimulator, getAvailableSimulators } = await import('../lib/simulator_manager.js');
        let udid = destinationRaw;
        if (udid) {
          const device = await findSimulator(udid);
          if (!device) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                code: 'SIMULATOR_NOT_FOUND',
                message: `No simulator found matching: ${udid}`,
                suggestion: 'Use xcode_list_simulators to see available simulators.',
              }) }],
              isError: true,
            };
          }
          udid = device.udid;
        } else {
          const devices = await getAvailableSimulators();
          const booted = devices.find((d) => d.state === 'Booted');
          if (!booted) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                code: 'NO_BOOTED_SIMULATOR',
                message: 'No booted simulator found.',
                suggestion: 'Boot one with xcode_boot_simulator or pass an explicit destination.',
              }) }],
              isError: true,
            };
          }
          udid = booted.udid;
        }

        const { tmpdir } = await import('node:os');
        const { join: joinPath } = await import('node:path');
        const safeScheme = scheme.replace(/[^A-Za-z0-9._-]+/g, '_');
        const tracePath = joinPath(tmpdir(), `${safeScheme}-${Date.now()}.trace`);

        // Device-only recording (no --target): valid for all templates and
        // does not require a scheme-named runnable product.
        await xcrun('xctrace', [
          'record',
          '--template', template,
          '--device', udid,
          '--time-limit', `${durationSeconds}s`,
          '--output', tracePath,
        ]);

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            output_path: tracePath,
            scheme,
            udid,
            template,
            duration_seconds: durationSeconds,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'PROFILE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure a simulator is booted and the template name is valid.',
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
      if (typeof args.url !== 'string') {
        const { invalidInput } = await import('../lib/error_handler.js');
        throw invalidInput('url', 'Must be a string.');
      }
      const url = args.url.trim();
      if (!/^https:\/\/[^/\s]+\/.+/.test(url)) {
        const { invalidInput } = await import('../lib/error_handler.js');
        throw invalidInput('url', 'Must be an https repository URL (e.g. https://github.com/org/Package.git).');
      }
      const { requireTargetName } = await import('../lib/validation.js');
      const targetName = requireTargetName(args.target);

      const rawReq = args.version_requirement as { type?: unknown; value?: unknown } | undefined;
      const allowedReqTypes = ['exact', 'upToNextMajorVersion', 'upToNextMinorVersion', 'branch', 'revision'];
      const versionType = (typeof rawReq?.type === 'string' ? rawReq.type : 'upToNextMajorVersion');
      const versionValue = (typeof rawReq?.value === 'string' ? rawReq.value.trim() : '1.0.0');
      const { invalidInput: invalidInputFn } = await import('../lib/error_handler.js');
      if (!allowedReqTypes.includes(versionType)) {
        throw invalidInputFn('version_requirement.type', `Must be one of: ${allowedReqTypes.join(', ')}.`);
      }
      if (!versionValue) {
        throw invalidInputFn('version_requirement.value', 'Must be a non-empty version, branch or revision.');
      }

      try {
        const { addSPMPackage } = await import('../lib/pbxproj_writer.js');
        const added = addSPMPackage(config.projectPath, url, {
          type: versionType as 'exact' | 'upToNextMajorVersion' | 'upToNextMinorVersion' | 'branch' | 'revision',
          value: versionValue,
        }, targetName);

        const { resolvePackageDependencies } = await import('../lib/xcode_runner.js');
        const result = await resolvePackageDependencies(config.projectPath);

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            package_name: added.packageName,
            product_name: added.productName,
            url,
            version: `${versionType}: ${versionValue}`,
            target: targetName,
            resolved: result,
            note: `Linked product "${added.productName}". If the package's product name differs, adjust the XCSwiftPackageProductDependency in Xcode.`,
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
