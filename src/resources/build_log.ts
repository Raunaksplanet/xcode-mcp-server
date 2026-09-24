import type { XcodeMCPServer } from '../server.js';
import { parseBuildOutput } from '../lib/xcode_runner.js';
import { readLatestBuildLog } from '../lib/build_log.js';

export function registerBuildLogResources(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerResource({
    uri: 'xcode://build/latest_log',
    name: 'Latest Build Log',
    description: 'Full text of the most recent build log',
    mimeType: 'text/plain',
    handler: async () => {
      const latest = readLatestBuildLog(config.projectPath);
      const text = latest.found
        ? latest.log.slice(-50000)
        : 'No build logs found. Build the project first.';
      return {
        contents: [{
          uri: 'xcode://build/latest_log',
          text,
          mimeType: 'text/plain',
        }],
      };
    },
  });

  server.registerResource({
    uri: 'xcode://build/errors',
    name: 'Latest Build Errors',
    description: 'Parsed errors from the latest build',
    mimeType: 'application/json',
    handler: async () => {
      const latest = readLatestBuildLog(config.projectPath);
      if (!latest.found) {
        return {
          contents: [{ uri: 'xcode://build/errors', text: JSON.stringify({ errors: [], warnings: [] }), mimeType: 'application/json' }],
        };
      }
      const parsed = parseBuildOutput(latest.log, '');

      return {
        contents: [{
          uri: 'xcode://build/errors',
          text: JSON.stringify(parsed, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  });
}
