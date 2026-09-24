#!/usr/bin/env node
/**
 * setup-clients.mjs — register xcode-mcp with AI coding clients.
 *
 * Supported clients:
 *   - opencode  : ~/.config/opencode/opencode.json  (v1 `mcp.<name>` + v2 `mcp.servers.<name>`)
 *   - cline     : ~/.cline/data/settings/cline_mcp_settings.json  (`mcpServers.<name>`)
 *   - kilo      : ~/.config/kilo/kilo.jsonc  (`mcp.<name>`, new CLI format)
 *                 + legacy VSCode globalStorage mcp_settings.json (`mcpServers.<name>`)
 *   - freebuff  : <project>/.agents/mcp.json and/or ~/.agents/mcp.json (`mcpServers.<name>`)
 *                 (Codebuff/Freebuff convention: .agents/mcp.json in cwd, parent, or home)
 *
 * Usage:
 *   node scripts/setup-clients.mjs --client all --project-path /path/to/App.xcodeproj [--scheme MyApp]
 *   node scripts/setup-clients.mjs --client cline,kilo --dry-run
 *   npm run setup:all -- --project-path /path/to/App.xcodeproj
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_NAME = 'xcode';

const CLIENTS = ['opencode', 'cline', 'kilo', 'freebuff'];

function parseArgs(argv) {
  const opts = {
    clients: [],
    projectPath: process.env.XCODE_PROJECT_PATH || '',
    scheme: process.env.XCODE_DEFAULT_SCHEME || '',
    serverPath: resolve(REPO_ROOT, 'dist', 'index.js'),
    dryRun: false,
    freebuffGlobal: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--client' || a === '--clients') {
      const v = argv[++i] || '';
      opts.clients.push(...v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    } else if (a.startsWith('--client=')) {
      opts.clients.push(...a.slice('--client='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    } else if (a === '--project-path') {
      opts.projectPath = argv[++i] || '';
    } else if (a.startsWith('--project-path=')) {
      opts.projectPath = a.slice('--project-path='.length);
    } else if (a === '--scheme') {
      opts.scheme = argv[++i] || '';
    } else if (a.startsWith('--scheme=')) {
      opts.scheme = a.slice('--scheme='.length);
    } else if (a === '--server-path') {
      opts.serverPath = argv[++i] || opts.serverPath;
    } else if (a.startsWith('--server-path=')) {
      opts.serverPath = a.slice('--server-path='.length);
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--freebuff-global') {
      opts.freebuffGlobal = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    }
  }
  if (opts.clients.includes('all')) opts.clients = [...CLIENTS];
  opts.clients = [...new Set(opts.clients)];
  return opts;
}

function printHelp() {
  console.log(`
xcode-mcp client setup

Usage:
  node scripts/setup-clients.mjs --client <name|all> [options]

Clients: ${CLIENTS.join(', ')}, all

Options:
  --client <list>        Comma-separated client list (repeatable). Default: all
  --project-path <path>  Path to .xcodeproj / .xcworkspace (or $XCODE_PROJECT_PATH)
  --scheme <name>        Default scheme (or $XCODE_DEFAULT_SCHEME)
  --server-path <path>   Path to built server (default: <repo>/dist/index.js)
  --dry-run              Print what would change without writing files
  --freebuff-global      Also write ~/.agents/mcp.json (freebuff searches cwd, parent, home)
  --help                 Show this help

Examples:
  node scripts/setup-clients.mjs --client all --project-path ~/Projects/MyApp.xcodeproj
  node scripts/setup-clients.mjs --client cline,kilo --dry-run
`);
}

/** Expand leading ~/ and resolve to absolute path. */
function expandPath(p) {
  if (!p) return '';
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p.replace(/^~$/, homedir()));
}

/** Strip // and block comments without touching string contents. */
function stripJsoncComments(raw) {
  let out = '';
  let inStr = false;
  let esc = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Read JSON/JSONC (strip // and block comments). Returns {} when missing/invalid. */
function readJsonc(filePath) {
  try {
    if (!existsSync(filePath)) return { data: {}, exists: false };
    const raw = readFileSync(filePath, 'utf-8');
    const stripped = stripJsoncComments(raw);
    if (!stripped.trim()) return { data: {}, exists: true };
    return { data: JSON.parse(stripped), exists: true };
  } catch (err) {
    console.warn(`[!] Could not parse ${filePath}: ${err.message} — starting from {}.`);
    return { data: {}, exists: existsSync(filePath) };
  }
}

function writeJson(filePath, data, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] would write ${filePath}:\n${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, `${filePath}.bak`);
    } catch { /* best effort */ }
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`[✓] Updated ${filePath}`);
}

function envBlock(projectPath, scheme) {
  const env = {};
  if (projectPath) env.XCODE_PROJECT_PATH = projectPath;
  if (scheme) env.XCODE_DEFAULT_SCHEME = scheme;
  return env;
}

function stdioEntry(serverPath, projectPath, scheme) {
  return {
    command: 'node',
    args: [serverPath],
    env: envBlock(projectPath, scheme),
  };
}

// ---------------------------------------------------------------------------
// Per-client registrars
// ---------------------------------------------------------------------------

function registerOpencode(serverPath, projectPath, scheme, dryRun) {
  // Prefer existing opencode.jsonc, else opencode.json.
  const base = join(homedir(), '.config', 'opencode');
  const jsoncPath = join(base, 'opencode.jsonc');
  const jsonPath = join(base, 'opencode.json');
  const target = existsSync(jsoncPath) && !existsSync(jsonPath) ? jsoncPath : jsonPath;

  const { data: config } = readJsonc(target);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`Existing ${target} is not a JSON object.`);
  }
  config.mcp = typeof config.mcp === 'object' && config.mcp !== null ? config.mcp : {};

  // v1 shape:  mcp.<name> = { type: local, command: [...], environment: {...}, enabled: true }
  const v1 = {
    type: 'local',
    command: ['node', serverPath],
    enabled: true,
  };
  const env = envBlock(projectPath, scheme);
  if (Object.keys(env).length > 0) v1.environment = env;

  config.mcp[SERVER_NAME] = v1;

  // v2 shape:  mcp.servers.<name> = same object (v2 uses `disabled` instead of `enabled`)
  config.mcp.servers = typeof config.mcp.servers === 'object' && config.mcp.servers !== null
    ? config.mcp.servers
    : {};
  config.mcp.servers[SERVER_NAME] = { ...v1 };
  delete config.mcp.servers[SERVER_NAME].enabled;

  writeJson(target, config, dryRun);
  return [target];
}

function registerCline(serverPath, projectPath, scheme, dryRun) {
  const primary = join(homedir(), '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  const { data: config } = readJsonc(primary);
  config.mcpServers = typeof config.mcpServers === 'object' && config.mcpServers !== null
    ? config.mcpServers
    : {};
  config.mcpServers[SERVER_NAME] = {
    ...stdioEntry(serverPath, projectPath, scheme),
    disabled: false,
  };
  writeJson(primary, config, dryRun);

  // Legacy VSCode extension path — only touch if it already exists (don't create clutter).
  const legacyPaths = [];
  if (process.platform === 'darwin') {
    legacyPaths.push(join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'));
  } else {
    legacyPaths.push(join(homedir(), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'));
  }
  for (const lp of legacyPaths) {
    if (existsSync(lp)) {
      const { data: legacy } = readJsonc(lp);
      legacy.mcpServers = typeof legacy.mcpServers === 'object' && legacy.mcpServers !== null ? legacy.mcpServers : {};
      legacy.mcpServers[SERVER_NAME] = { ...stdioEntry(serverPath, projectPath, scheme), disabled: false };
      writeJson(lp, legacy, dryRun);
    }
  }
  return [primary];
}

function registerKilo(serverPath, projectPath, scheme, dryRun) {
  const touched = [];
  // New CLI/global format: ~/.config/kilo/kilo.jsonc  →  { mcp: { xcode: {...} } }
  const globalPath = join(homedir(), '.config', 'kilo', 'kilo.jsonc');
  const { data: config } = readJsonc(globalPath);
  config.mcp = typeof config.mcp === 'object' && config.mcp !== null ? config.mcp : {};
  const entry = {
    type: 'local',
    command: ['node', serverPath],
    enabled: true,
    timeout: 10000,
  };
  const env = envBlock(projectPath, scheme);
  if (Object.keys(env).length > 0) entry.environment = env;
  config.mcp[SERVER_NAME] = entry;
  writeJson(globalPath, config, dryRun);
  touched.push(globalPath);

  // Legacy VSCode globalStorage format (mcp_settings.json, mcpServers shape) — update if present.
  const legacyCandidates = [];
  if (process.platform === 'darwin') {
    legacyCandidates.push(join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'kilo-code.kilo-code', 'settings', 'mcp_settings.json'));
  } else if (process.platform === 'win32' && process.env.APPDATA) {
    legacyCandidates.push(join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'kilo-code.kilo-code', 'settings', 'mcp_settings.json'));
  } else {
    legacyCandidates.push(join(homedir(), '.config', 'Code', 'User', 'globalStorage', 'kilo-code.kilo-code', 'settings', 'mcp_settings.json'));
  }
  for (const lp of legacyCandidates) {
    if (existsSync(lp)) {
      const { data: legacy } = readJsonc(lp);
      legacy.mcpServers = typeof legacy.mcpServers === 'object' && legacy.mcpServers !== null ? legacy.mcpServers : {};
      legacy.mcpServers[SERVER_NAME] = { ...stdioEntry(serverPath, projectPath, scheme), disabled: false };
      writeJson(lp, legacy, dryRun);
      touched.push(lp);
    }
  }
  return touched;
}

function registerFreebuff(serverPath, projectPath, scheme, dryRun, { global = false } = {}) {
  const touched = [];
  const entry = stdioEntry(serverPath, projectPath, scheme);

  // Project-local: <xcode-project-dir>/.agents/mcp.json, else <repo>/.agents/mcp.json.
  // (Freebuff/Codebuff loads .agents/mcp.json from cwd, parent, and home.)
  let projectDir = REPO_ROOT;
  if (projectPath) {
    const expanded = expandPath(projectPath);
    projectDir = expanded.endsWith('.xcodeproj') || expanded.endsWith('.xcworkspace')
      ? dirname(expanded)
      : expanded;
  }
  const localPath = join(projectDir, '.agents', 'mcp.json');
  const { data: local } = readJsonc(localPath);
  local.mcpServers = typeof local.mcpServers === 'object' && local.mcpServers !== null ? local.mcpServers : {};
  local.mcpServers[SERVER_NAME] = entry;
  writeJson(localPath, local, dryRun);
  touched.push(localPath);

  if (global) {
    const homePath = join(homedir(), '.agents', 'mcp.json');
    if (homePath !== localPath) {
      const { data: home } = readJsonc(homePath);
      home.mcpServers = typeof home.mcpServers === 'object' && home.mcpServers !== null ? home.mcpServers : {};
      home.mcpServers[SERVER_NAME] = entry;
      writeJson(homePath, home, dryRun);
      touched.push(homePath);
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let clients = opts.clients.length > 0 ? opts.clients : [...CLIENTS];
  const unknown = clients.filter((c) => !CLIENTS.includes(c));
  if (unknown.length > 0) {
    console.error(`Unknown client(s): ${unknown.join(', ')}. Valid: ${CLIENTS.join(', ')}, all`);
    process.exit(1);
  }

  let projectPath = opts.projectPath ? expandPath(opts.projectPath.trim()) : '';
  let scheme = (opts.scheme || '').trim();
  if (projectPath && !scheme) {
    // Guess scheme from bundle name (MyApp.xcodeproj → MyApp).
    const base = basename(projectPath).replace(/\.(xcodeproj|xcworkspace)$/, '');
    if (base) scheme = base;
  }
  const serverPath = expandPath(opts.serverPath);

  if (!existsSync(serverPath) && !opts.dryRun) {
    console.warn(`[!] Server not found at ${serverPath} — run \`npm run build\` first. Writing config anyway.`);
  }
  if (projectPath && !existsSync(projectPath)) {
    console.warn(`[!] Project path does not exist: ${projectPath} — writing config anyway.`);
  }

  console.log(`xcode-mcp client setup → ${clients.join(', ')}`);
  console.log(`  server:  ${serverPath}`);
  if (projectPath) console.log(`  project: ${projectPath}`);
  if (scheme) console.log(`  scheme:  ${scheme}`);
  if (opts.dryRun) console.log('  (dry-run: no files will be written)');

  const registrars = {
    opencode: () => registerOpencode(serverPath, projectPath, scheme, opts.dryRun),
    cline: () => registerCline(serverPath, projectPath, scheme, opts.dryRun),
    kilo: () => registerKilo(serverPath, projectPath, scheme, opts.dryRun),
    freebuff: () => registerFreebuff(serverPath, projectPath, scheme, opts.dryRun, { global: opts.freebuffGlobal }),
  };

  const allTouched = [];
  for (const client of clients) {
    try {
      const touched = registrars[client]();
      allTouched.push(...touched);
    } catch (err) {
      console.error(`[✗] ${client}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  if (!opts.dryRun) {
    console.log('\nDone. Restart your AI client so it picks up the new MCP server.');
    console.log('Verify: ask the client to list MCP tools, or check the files above for an "xcode" entry.');
  } else {
    console.log('\nDry-run complete. Re-run without --dry-run to write files.');
  }
  void tmpdir;
}

main();
