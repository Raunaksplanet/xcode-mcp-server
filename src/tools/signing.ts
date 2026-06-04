import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { XcodeMCPServer } from '../server.js';
import { setBuildSetting } from '../lib/pbxproj_writer.js';

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
        const files = readdirSync(profilesDir).filter(f => f.endsWith('.mobileprovision'));

        const profiles = [];
        for (const file of files) {
          const filePath = join(profilesDir, file);
          const result = await execFileAsync('security', ['cms', '-D', '-i', filePath]);
          const content = result.stdout;
          const nameMatch = content.match(/<key>Name<\/key>\s*<string>(.+?)<\/string>/);
          const bundleIdMatch = content.match(/<key>application-identifier<\/key>\s*<string>(.+?)<\/string>/);
          const teamMatch = content.match(/<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>(.+?)<\/string>/);
          const expiryMatch = content.match(/<key>ExpirationDate<\/key>\s*<date>(.+?)<\/date>/);
          const devCountMatch = content.match(/<key>ProvisionedDevices<\/key>\s*<array>\s*<string>(.+?)<\/string>/s);

          profiles.push({
            file,
            name: nameMatch?.[1] || 'Unknown',
            bundle_id: bundleIdMatch?.[1] ? bundleIdMatch[1].replace(/^[A-Z0-9]+\./, '') : 'Unknown',
            team_id: teamMatch?.[1] || 'Unknown',
            expiry: expiryMatch?.[1] || 'Unknown',
            device_count: devCountMatch ? content.split('ProvisionedDevices')[1]?.split('<string>').length! - 1 : 0,
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
      const target = args.target as string;
      const teamId = args.team_id as string;
      const bundleId = args.bundle_id as string;
      const automatic = (args.automatic as boolean) !== false;

      try {
        for (const cfg of ['Debug', 'Release']) {
          const projectPath = server.config.projectPath;
          setBuildSetting(projectPath, target, cfg, 'DEVELOPMENT_TEAM', teamId);
          setBuildSetting(projectPath, target, cfg, 'PRODUCT_BUNDLE_IDENTIFIER', bundleId);

          if (automatic) {
            setBuildSetting(projectPath, target, cfg, 'CODE_SIGN_STYLE', 'Automatic');
          } else {
            setBuildSetting(projectPath, target, cfg, 'CODE_SIGN_STYLE', 'Manual');
            if (args.profile_name) {
              setBuildSetting(projectPath, target, cfg, 'PROVISIONING_PROFILE_SPECIFIER', args.profile_name as string);
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
      const appPath = args.app_path as string;

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
