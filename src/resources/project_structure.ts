import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { XcodeMCPServer } from '../server.js';
import { getProjectInfo } from '../lib/pbxproj_parser.js';

interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: TreeNode[];
  file_type?: string;
  size?: number;
}

function buildFileTree(dirPath: string, projectDir: string, excludedPaths: string[] = []): TreeNode[] {
  const entries: TreeNode[] = [];

  try {
    const items = readdirSync(dirPath);
    for (const item of items) {
      const fullPath = join(dirPath, item);
      const relPath = relative(projectDir, fullPath);

      if (excludedPaths.some(p => relPath.startsWith(p))) continue;
      if (item.startsWith('.') || item === 'DerivedData' || item === 'build') continue;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const children = buildFileTree(fullPath, projectDir, excludedPaths);
          entries.push({
            name: item,
            type: 'directory',
            path: relPath,
            children,
          });
        } else {
          const ext = item.split('.').pop()?.toLowerCase() || '';
          const typeMap: Record<string, string> = {
            swift: 'swift',
            m: 'objc',
            mm: 'objc',
            h: 'objc-header',
            storyboard: 'storyboard',
            xib: 'xib',
            xcassets: 'xcassets',
            plist: 'plist',
            strings: 'strings',
            json: 'json',
            entitlements: 'entitlements',
            png: 'image',
            jpg: 'image',
            jpeg: 'image',
            pdf: 'image',
            svg: 'image',
          };
          entries.push({
            name: item,
            type: 'file',
            path: relPath,
            file_type: typeMap[ext] || 'other',
            size: stat.size,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    return entries;
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

export function registerProjectResources(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerResource({
    uri: 'xcode://project/structure',
    name: 'Project File Tree',
    description: 'Full project file tree with types and sizes',
    mimeType: 'application/json',
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      const excludedPaths = config.projectConfig.excluded_paths || [];
      const tree = buildFileTree(config.projectDir, config.projectDir, excludedPaths);

      return {
        contents: [{
          uri: 'xcode://project/structure',
          text: JSON.stringify({
            project: info.name,
            path: config.projectPath,
            targets: info.targets.map(t => t.name),
            schemes: info.schemes.map(s => s.name),
            file_tree: tree,
          }, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  });

  server.registerResource({
    uri: 'xcode://project/settings',
    name: 'Project Build Settings',
    description: 'All build settings for all targets and configurations',
    mimeType: 'application/json',
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      const settings: Record<string, Record<string, Record<string, string>>> = {};

      for (const target of info.targets) {
        settings[target.name] = {};
        for (const config of target.configurations) {
          settings[target.name]![config.name] = config.settings as Record<string, string>;
        }
      }

      return {
        contents: [{
          uri: 'xcode://project/settings',
          text: JSON.stringify(settings, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  });

  server.registerResource({
    uri: 'xcode://simulators/list',
    name: 'Available Simulators',
    description: 'List of all available simulators with their state',
    mimeType: 'application/json',
    handler: async () => {
      const { getAvailableSimulators } = await import('../lib/simulator_manager.js');
      const simulators = await getAvailableSimulators();
      return {
        contents: [{
          uri: 'xcode://simulators/list',
          text: JSON.stringify(simulators, null, 2),
          mimeType: 'application/json',
        }],
      };
    },
  });
}
