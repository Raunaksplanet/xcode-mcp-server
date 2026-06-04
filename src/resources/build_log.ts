import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { XcodeMCPServer } from '../server.js';
import { parseBuildOutput } from '../lib/xcode_runner.js';

export function registerBuildLogResources(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerResource({
    uri: 'xcode://build/latest_log',
    name: 'Latest Build Log',
    description: 'Full text of the most recent build log',
    mimeType: 'text/plain',
    handler: async () => {
      const derivedData = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
      const projectName = config.projectPath.split('/').pop()?.replace(/\.xcodeproj$/, '') || '';
      const dirs = readdirSync(derivedData);
      const matchingDir = dirs.find(d => d.startsWith(projectName));

      if (!matchingDir) {
        return {
          contents: [{ uri: 'xcode://build/latest_log', text: 'No build logs found. Build the project first.', mimeType: 'text/plain' }],
        };
      }

      const buildLogDir = join(derivedData, matchingDir, 'Logs', 'Build');
      if (!existsSync(buildLogDir)) {
        return {
          contents: [{ uri: 'xcode://build/latest_log', text: 'No build logs found.', mimeType: 'text/plain' }],
        };
      }

      const logFiles = readdirSync(buildLogDir)
        .filter(f => f.endsWith('.xcactivitylog'))
        .map(f => ({ name: f, time: statSync(join(buildLogDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

      if (logFiles.length === 0) {
        return {
          contents: [{ uri: 'xcode://build/latest_log', text: 'No build logs found.', mimeType: 'text/plain' }],
        };
      }

      const logContent = readFileSync(join(buildLogDir, logFiles[0]!.name), 'utf-8');
      return {
        contents: [{
          uri: 'xcode://build/latest_log',
          text: logContent.slice(-50000),
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
      const derivedData = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
      const projectName = config.projectPath.split('/').pop()?.replace(/\.xcodeproj$/, '') || '';
      const dirs = readdirSync(derivedData);
      const matchingDir = dirs.find(d => d.startsWith(projectName));

      if (!matchingDir) {
        return {
          contents: [{ uri: 'xcode://build/errors', text: JSON.stringify({ errors: [], warnings: [] }), mimeType: 'application/json' }],
        };
      }

      const buildLogDir = join(derivedData, matchingDir, 'Logs', 'Build');
      if (!existsSync(buildLogDir)) {
        return {
          contents: [{ uri: 'xcode://build/errors', text: JSON.stringify({ errors: [], warnings: [] }), mimeType: 'application/json' }],
        };
      }

      const logFiles = readdirSync(buildLogDir)
        .filter(f => f.endsWith('.xcactivitylog'))
        .map(f => ({ name: f, time: statSync(join(buildLogDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

      if (logFiles.length === 0) {
        return {
          contents: [{ uri: 'xcode://build/errors', text: JSON.stringify({ errors: [], warnings: [] }), mimeType: 'application/json' }],
        };
      }

      const logContent = readFileSync(join(buildLogDir, logFiles[0]!.name), 'utf-8');
      const parsed = parseBuildOutput(logContent, '');

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
