import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { XcodeMCPServer } from '../server.js';
import { setBuildSetting } from '../lib/pbxproj_writer.js';
import { requireTargetName, requireNonEmptyString, optionalString } from '../lib/validation.js';
import { invalidInput } from '../lib/error_handler.js';

const execFileAsync = promisify(execFile);

export function registerSigningTools(server: XcodeMCPServer): void {

  server.registerTool({
    name: 'xcode_list_certificates',
    description: 'List all valid code signing certificates',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      try {
        const result = await execFileAsync('security', ['find-identity', '-v', '-p', 'codesigning']);
        const lines = result.stdout.split('\n').filter(Boolean);
        const certificates = lines.map(line => {
          const match = line.match(/^\s+\d+\)\s+([A-F0-9]+)\s+"(.+?)"/);
          if (match && match[1] && match[2]) {
            return {
              sha1: match[1],
              name: match[2],
            };
          }
          return null;
        }).filter(Boolean);
        return {
          content: [{ type: 'text', text: JSON.stringify(certificates, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'CERTIFICATE_LIST_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure Xcode is installed and you have valid signing certificates.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_list_provisioning_profiles',
    description: 'List all provisioning profiles',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      try {
        const profilesDir = join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
        let files: string[];
        try {
          files = readdirSync(profilesDir).filter(f => f.endsWith('.mobileprovision'));
        } catch {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              profiles: [],
              message: 'No provisioning profiles directory found. Install profiles via Xcode first.',
            }, null, 2) }],
          };
        }

        const profiles = [];
        for (const file of files) {
          const filePath = join(profilesDir, file);
          const result = await execFileAsync('security', ['cms', '-D', '-i', filePath]);
          const content = result.stdout;
          const nameMatch = content.match(/<key>Name<\/key>\s*<string>(.+?)<\/string>/);
          const bundleIdMatch = content.match(/<key>application-identifier<\/key>\s*<string>(.+?)<\/string>/);
          const teamMatch = content.match(/<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>(.+?)<\/string>/);
          const expiryMatch = content.match(/<key>ExpirationDate<\/key>\s*<date>(.+?)<\/date>/);
          // Count devices safely: split only when the section exists.
          let deviceCount = 0;
          const deviceSection = content.split('ProvisionedDevices')[1];
          if (deviceSection) {
            deviceCount = Math.max(0, deviceSection.split('<string>').length - 1);
          }

          profiles.push({
            file,
            name: nameMatch?.[1] || 'Unknown',
            bundle_id: bundleIdMatch?.[1] ? bundleIdMatch[1].replace(/^[A-Z0-9]+\./, '') : 'Unknown',
            team_id: teamMatch?.[1] || 'Unknown',
            expiry: expiryMatch?.[1] || 'Unknown',
            device_count: deviceCount,
          });
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(profiles, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'PROFILE_LIST_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure you have provisioning profiles installed.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_set_signing',
    description: 'Set code signing settings for a target',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name' },
        team_id: { type: 'string', description: 'Team ID' },
        bundle_id: { type: 'string', description: 'Bundle identifier' },
        profile_name: { type: 'string', description: 'Provisioning profile name' },
        automatic: { type: 'boolean', description: 'Use automatic signing', default: true },
      },
      required: ['target', 'team_id', 'bundle_id'],
    },
    handler: async (args) => {
      const target = requireTargetName(args.target);
      const teamId = requireNonEmptyString(args.team_id, 'team_id', 64);
      if (!/^[A-Z0-9]{10}$/.test(teamId)) {
        throw invalidInput('team_id', 'Must be a 10-character Apple Team ID (e.g. A1B2C3D4E5).');
      }
      const bundleId = requireNonEmptyString(args.bundle_id, 'bundle_id', 256);
      if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(bundleId)) {
        throw invalidInput('bundle_id', 'Must be a reverse-DNS bundle identifier (e.g. com.example.App).');
      }
      if (args.automatic !== undefined && typeof args.automatic !== 'boolean') {
        throw invalidInput('automatic', 'Must be a boolean.');
      }
      const automatic = (args.automatic as boolean) !== false;
      const profileName = optionalString(args.profile_name, 'profile_name', 256);

      try {
        for (const cfg of ['Debug', 'Release']) {
          const projectPath = server.config.projectPath;
          setBuildSetting(projectPath, target, cfg, 'DEVELOPMENT_TEAM', teamId);
          setBuildSetting(projectPath, target, cfg, 'PRODUCT_BUNDLE_IDENTIFIER', bundleId);

          if (automatic) {
            setBuildSetting(projectPath, target, cfg, 'CODE_SIGN_STYLE', 'Automatic');
          } else {
            setBuildSetting(projectPath, target, cfg, 'CODE_SIGN_STYLE', 'Manual');
            if (profileName) {
              setBuildSetting(projectPath, target, cfg, 'PROVISIONING_PROFILE_SPECIFIER', profileName);
            }
          }
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            target,
            team_id: teamId,
            bundle_id: bundleId,
            automatic,
          }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SIGNING_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Verify the target name and team ID are correct.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_validate_signing',
    description: 'Validate code signing of an app bundle',
    inputSchema: {
      type: 'object',
      properties: {
        app_path: { type: 'string', description: 'Path to .app bundle' },
      },
      required: ['app_path'],
    },
    handler: async (args) => {
      const appPath = requireNonEmptyString(args.app_path, 'app_path', 1024);
      if (!appPath.endsWith('.app')) {
        throw invalidInput('app_path', 'Must point to a .app bundle.');
      }

      try {
        const result = await execFileAsync('codesign', ['--verify', '--verbose', appPath]);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            valid: true,
            message: 'Code signature is valid',
            details: result.stderr || result.stdout,
          }, null, 2) }],
        };
      } catch (error) {
        const err = error as { stderr?: string; stdout?: string; message?: string };
        return {
          content: [{ type: 'text', text: JSON.stringify({
            valid: false,
            message: 'Code signature validation failed',
            details: err.stderr || err.stdout || err.message || String(error),
          }, null, 2) }],
          isError: false,
        };
      }
    },
  });
}
