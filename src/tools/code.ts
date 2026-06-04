import { existsSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { XcodeMCPServer } from '../server.js';
import { logger } from '../lib/logger.js';
import { pathTraversalDetected, fileNotFound } from '../lib/error_handler.js';

function assertPathInProject(projectDir: string, filePath: string): string {
  const resolved = resolvePath(projectDir, filePath);
  if (!resolved.startsWith(projectDir)) {
    throw pathTraversalDetected(filePath);
  }
  return resolved;
}

export function registerCodeTools(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerTool({
    name: 'xcode_read_file',
    description: 'Read a Swift/ObjC file from the project',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path relative to project root',
        },
      },
      required: ['file_path'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true,
        };
      }

      const content = await readFile(resolvedPath, 'utf-8');
      const fileStat = await stat(resolvedPath);
      const lines = content.split('\n');

      return {
        content: [{ type: 'text', text: JSON.stringify({
          file_path: filePath,
          content,
          line_count: lines.length,
          file_size: fileStat.size,
          last_modified: fileStat.mtime.toISOString(),
        }, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_write_file',
    description: 'Write content to a Swift/ObjC file in the project',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path relative to project root',
        },
        content: {
          type: 'string',
          description: 'File content',
        },
        create_if_missing: {
          type: 'boolean',
          description: 'Create file if it does not exist and add to project',
          default: true,
        },
      },
      required: ['file_path', 'content'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const content = args.content as string;
      const createIfMissing = (args.create_if_missing as boolean) !== false;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      const fileExists = existsSync(resolvedPath);

      if (!fileExists && !createIfMissing) {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true,
        };
      }

      const { mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(resolvedPath), { recursive: true });

      await writeFile(resolvedPath, content, 'utf-8');
      logger.info(`Wrote file: ${resolvedPath}`);

      if (!fileExists && createIfMissing) {
        try {
          const { getProjectInfo } = await import('../lib/pbxproj_parser.js');
          const { addFileToProject } = await import('../lib/pbxproj_writer.js');
          const info = getProjectInfo(config.projectPath);
          const target = info.targets[0];
          if (target) {
            addFileToProject(config.projectPath, filePath, target.name, content);
          }
        } catch (err) {
          logger.warn(`Could not auto-add file to project: ${err}`);
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          file_path: filePath,
          created: !fileExists,
        }) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_edit_file',
    description: 'Find and replace content in a file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path relative to project root',
        },
        old_content: {
          type: 'string',
          description: 'Exact text to find',
        },
        new_content: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['file_path', 'old_content', 'new_content'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const oldContent = args.old_content as string;
      const newContent = args.new_content as string;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true,
        };
      }

      let content = await readFile(resolvedPath, 'utf-8');
      const occurrences = content.split(oldContent).length - 1;

      if (occurrences === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'CONTENT_NOT_FOUND',
            message: `Could not find the specified text in ${filePath}`,
            suggestion: 'Check the exact content to match, including whitespace.',
          }) }],
          isError: true,
        };
      }

      if (occurrences >= 2) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'MULTIPLE_MATCHES',
            message: `Found ${occurrences} matches in ${filePath}. Provide more context for a unique match.`,
          }) }],
          isError: true,
        };
      }

      content = content.replace(oldContent, newContent);
      await writeFile(resolvedPath, content, 'utf-8');

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          file_path: filePath,
          replacements: 1,
        }) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_get_swift_symbols',
    description: 'Extract Swift symbols (classes, structs, enums, protocols, functions, properties)',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path relative to project root',
        },
      },
      required: ['file_path'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      if (!existsSync(resolvedPath)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true,
        };
      }

      const content = await readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      const symbols: Array<{
        kind: string;
        name: string;
        line: number;
        accessLevel?: string;
      }> = [];

      const patterns: Array<{ regex: RegExp; kind: string }> = [
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(class)\s+(\w+)/, kind: 'class' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(struct)\s+(\w+)/, kind: 'struct' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(enum)\s+(\w+)/, kind: 'enum' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(protocol)\s+(\w+)/, kind: 'protocol' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(extension)\s+(\w+)/, kind: 'extension' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*func\s+(\w+)/, kind: 'function' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*var\s+(\w+)/, kind: 'property' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*let\s+(\w+)/, kind: 'constant' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*typealias\s+(\w+)/, kind: 'typealias' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*associatedtype\s+(\w+)/, kind: 'associatedtype' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*actor\s+(\w+)/, kind: 'actor' },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(case)\s+(\w+)/, kind: 'enum_case' },
      ];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();

        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

        for (const { regex, kind } of patterns) {
          const match = trimmed.match(regex);
          if (match) {
            const accessLevel = match[1] || undefined;
            const name = match[match.length - 1]!;
            if (name && !name.startsWith('//')) {
              symbols.push({
                kind,
                name,
                line: i + 1,
                accessLevel: accessLevel !== 'open' ? accessLevel : undefined,
              });
            }
            break;
          }
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(symbols, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_format_file',
    description: 'Format a Swift file using swift-format',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'File path or directory to format (relative to project root)',
        },
      },
      required: ['file_path'],
    },
    handler: async (args) => {
      const filePath = args.file_path as string;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);

      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        await execFileAsync('which', ['swift-format']);
        await execFileAsync('swift-format', ['--in-place', resolvedPath]);
        const diffResult = await execFileAsync('swift-format', ['--diagnostics', resolvedPath]);

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            file_path: filePath,
            diagnostics: diffResult.stdout,
          }, null, 2) }],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('swift-format')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              code: 'SWIFT_FORMAT_NOT_FOUND',
              message: 'swift-format is not installed',
              suggestion: 'Install via: brew install swift-format\nOr: mint install swift-format',
            }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'FORMAT_FAILED',
            message: errMsg,
            suggestion: 'Check that the file exists and swift-format is installed.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_search_in_project',
    description: 'Search for text across all project files',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        file_type: {
          type: 'string',
          description: 'Filter by file extension (e.g., swift, objc)',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Case sensitive search',
          default: false,
        },
        regex: {
          type: 'boolean',
          description: 'Use regex for search',
          default: false,
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = args.query as string;
      const fileType = args.file_type as string | undefined;
      const caseSensitive = (args.case_sensitive as boolean) || false;
      const useRegex = (args.regex as boolean) || false;

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const grepArgs = ['-rn'];

      if (!caseSensitive) {
        grepArgs.push('-i');
      }

      if (useRegex) {
        grepArgs.push('-E');
      }

      if (fileType && fileType !== 'other') {
        const extMap: Record<string, string> = {
          swift: '*.swift',
          objc: '*.{m,mm,h}',
          storyboard: '*.storyboard',
          xib: '*.xib',
          plist: '*.plist',
          json: '*.json',
        };
        grepArgs.push('--include', extMap[fileType] || `*.${fileType}`);
      } else {
        grepArgs.push('--include', '*.swift', '--include', '*.m', '--include', '*.mm', '--include', '*.h');
      }

      grepArgs.push(query, config.projectDir);

      try {
        const result = await execFileAsync('grep', grepArgs, { timeout: 30000 });
        const lines = result.stdout.split('\n').filter(Boolean);
        const matches = lines.map(line => {
          const parts = line.split(':');
          return {
            file_path: parts[0] || '',
            line_number: parseInt(parts[1] || '0', 10),
            line_content: parts.slice(2).join(':'),
          };
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ matches, total: matches.length }, null, 2) }],
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (String(err.code) === '1') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ matches: [], total: 0 }) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SEARCH_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Check the query syntax and try again.',
          }) }],
          isError: true,
        };
      }
    },
  });
}
