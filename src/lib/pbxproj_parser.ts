import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import type {
  ParsedPBXProject,
  PBXObject,
  PBXFileReference,
  PBXBuildFile,
  PBXNativeTarget,
  XCBuildConfiguration,
  XCConfigurationList,
  PBXSourcesBuildPhase,
  PBXResourcesBuildPhase,
  TargetInfo,
  SchemeInfo,
  ProjectInfo,
  FileEntry,
} from '../types/pbxproj.js';

/** Split a comma list, ignoring commas inside double-quoted strings. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inStr = false;
  let esc = false;
  for (const ch of value) {
    if (inStr) {
      current += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      current += ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(item: string): string {
  item = item.trim();
  if (item.startsWith('"') && item.endsWith('"') && item.length >= 2) {
    return item.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return item;
}

function parsePBXValue(value: string): string | string[] | boolean | number {
  value = value.trim();

  if (value === 'YES' || value === 'NO') {
    return value === 'YES';
  }

  // Integers only up to 15 digits: longer all-digit tokens are object
  // references (24-char IDs), and parseInt would silently corrupt them
  // (e.g. 5555... → 5.555e+23). They must stay strings.
  if (/^-?\d+$/.test(value)) {
    const digits = value.startsWith('-') ? value.length - 1 : value.length;
    if (digits <= 15) return parseInt(value, 10);
    return value;
  }

  if (/^-?\d+\.\d+$/.test(value)) {
    return parseFloat(value);
  }

  if (value.startsWith('(') && value.endsWith(')')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(unquote).filter((s) => s.length > 0);
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return unquote(value);
  }

  return value;
}

/**
 * Remove /* ... *\/ comments that appear outside double-quoted strings.
 * Real pbxproj files annotate nearly every entry (object IDs, file refs,
 * array items), so the tokenizer must not see them. Comment markers inside
 * quoted strings (e.g. shell scripts) are preserved.
 */
export function stripPbxComments(raw: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = raw.indexOf('*/', i + 2);
      i = end === -1 ? raw.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Skip whitespace and both comment styles. Returns the next content index. */
function skipTrivia(content: string, i: number): number {
  for (;;) {
    if (i >= content.length) return i;
    const ch = content[i];
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      const end = content.indexOf('\n', i);
      i = end === -1 ? content.length : end + 1;
      continue;
    }
    if (ch !== undefined && /\s/.test(ch)) {
      i++;
      continue;
    }
    return i;
  }
}

/**
 * Scan a value span starting at i (past `key =`): a quoted string (escapes
 * honoured, so embedded ';' don't terminate it), a balanced (...) array, or
 * a bare token up to the next ';'. Returns the raw span and the index just
 * past the value (before the trailing ';').
 */
function scanValueSpan(content: string, i: number): { raw: string; endIdx: number } {
  const first = content[i];
  if (first === '"') {
    let j = i + 1;
    while (j < content.length) {
      const ch = content[j]!;
      if (ch === '\\' && j + 1 < content.length) {
        j += 2;
        continue;
      }
      if (ch === '"') {
        return { raw: content.slice(i, j + 1), endIdx: j + 1 };
      }
      j++;
    }
    return { raw: content.slice(i), endIdx: content.length };
  }
  if (first === '(') {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    while (j < content.length) {
      const ch = content[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          return { raw: content.slice(i, j + 1), endIdx: j + 1 };
        }
      }
      j++;
    }
    return { raw: content.slice(i), endIdx: content.length };
  }
  const semi = content.indexOf(';', i);
  if (semi === -1) return { raw: content.slice(i), endIdx: content.length };
  return { raw: content.slice(i, semi), endIdx: semi };
}

function parsePBXObjectBlock(content: string, startIdx: number): { obj: Record<string, unknown>; endIdx: number } {
  const obj: Record<string, unknown> = {};
  let i = startIdx;

  while (i < content.length) {
    i = skipTrivia(content, i);
    if (i >= content.length) break;

    if (content[i] === '}') {
      return { obj, endIdx: i + 1 };
    }

    if (content[i] === ';') {
      i++;
      continue;
    }

    const keyMatch = content.slice(i).match(/^(\w+)\s*=\s*/);
    if (keyMatch) {
      const key = keyMatch[1]!;
      i += keyMatch[0].length;
      i = skipTrivia(content, i);

      if (content[i] === '{') {
        const nested = parsePBXObjectBlock(content, i + 1);
        // Nested blocks are objects — never stringify them (String(obj) would
        // produce "[object Object]" and permanently destroy the data on write).
        obj[key] = nested.obj;
        i = nested.endIdx;
        i = skipTrivia(content, i);
        if (content[i] === ';') i++;
        continue;
      }

      const { raw, endIdx } = scanValueSpan(content, i);
      obj[key] = parsePBXValue(raw);
      i = skipTrivia(content, endIdx);
      if (content[i] === ';') i++;
      else i = endIdx + 1;
      continue;
    }

    i++;
  }

  return { obj, endIdx: i };
}

export function parsePBXProject(filePath: string): ParsedPBXProject {
  logger.debug(`Parsing pbxproj: ${filePath}`);
  const raw = stripPbxComments(readFileSync(filePath, 'utf-8'));

  const objectsMatch = raw.match(/objects\s*=\s*\{/);
  if (!objectsMatch) {
    throw new Error('Invalid pbxproj: no objects section found');
  }

  const startIdx = objectsMatch.index! + objectsMatch[0].length;
  const objectsBlock = parsePBXObjectBlock(raw, startIdx);
  const objects = objectsBlock.obj as Record<string, PBXObject>;

  const archiveMatch = raw.match(/archiveVersion\s*=\s*(\d+)/);
  const objectVersionMatch = raw.match(/objectVersion\s*=\s*(\d+)/);
  const rootMatch = raw.match(/rootObject\s*=\s*([A-F0-9]{24})/);

  return {
    archiveVersion: archiveMatch ? parseInt(archiveMatch[1]!, 10) : 1,
    objectVersion: objectVersionMatch ? parseInt(objectVersionMatch[1]!, 10) : 0,
    classes: {},
    objects,
    rootObject: rootMatch?.[1] || '',
  };
}

function getObject<T extends PBXObject>(objects: Record<string, PBXObject>, id: string): T | undefined {
  return objects[id] as T | undefined;
}

function getBuildConfiguration(objects: Record<string, PBXObject>, configListId: string): XCBuildConfiguration[] {
  const configList = getObject<XCConfigurationList>(objects, configListId);
  if (!configList?.buildConfigurations) return [];
  return configList.buildConfigurations
    .map((id: string) => getObject<XCBuildConfiguration>(objects, id))
    .filter((c: XCBuildConfiguration | undefined): c is XCBuildConfiguration => c !== undefined);
}

function resolveBuildSetting(buildConfigs: XCBuildConfiguration[], key: string): string | undefined {
  for (const config of buildConfigs) {
    const val = config.buildSettings?.[key];
    if (val !== undefined) return String(val);
  }
  return undefined;
}

/** Resolve a .xcodeproj/.xcworkspace path to its project.pbxproj file. */
export function resolvePbxprojPath(projectPath: string): string {
  if (projectPath.endsWith('.xcodeproj')) {
    return resolve(`${projectPath}/project.pbxproj`);
  }
  if (projectPath.endsWith('.xcworkspace')) {
    // A workspace has no pbxproj of its own: use the sibling (or nested)
    // .xcodeproj with the same base name, else the first one found.
    const base = projectPath.replace(/\.xcworkspace$/, '');
    const sameName = `${base}.xcodeproj/project.pbxproj`;
    if (existsSync(sameName)) return resolve(sameName);
    const dir = resolve(projectPath, '..');
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith('.xcodeproj') && existsSync(resolve(dir, entry, 'project.pbxproj'))) {
          return resolve(dir, entry, 'project.pbxproj');
        }
      }
      // Last resort: workspace-internal project reference (rare).
      for (const entry of entries) {
        if (entry.endsWith('.xcodeproj')) return resolve(dir, entry, 'project.pbxproj');
      }
    } catch {
      // Fall through to the error below.
    }
    throw new Error(`No .xcodeproj found next to workspace: ${projectPath}`);
  }
  return resolve(projectPath);
}

export function getProjectInfo(projectPath: string): ProjectInfo {
  const pbxprojPath = resolvePbxprojPath(projectPath);

  const parsed = parsePBXProject(pbxprojPath);
  const { objects } = parsed;
  const projectObj = getObject<import('../types/pbxproj.js').PBXProject>(objects, parsed.rootObject);

  if (!projectObj) {
    throw new Error('Root PBXProject object not found');
  }

  const projectConfigs = getBuildConfiguration(objects, projectObj.buildConfigurationList);
  const configNames = projectConfigs.map(c => c.name).filter(Boolean);

  const targets: TargetInfo[] = [];
  for (const targetId of projectObj.targets || []) {
    const target = getObject<PBXNativeTarget>(objects, targetId);
    if (!target) continue;

    const targetConfigs = getBuildConfiguration(objects, target.buildConfigurationList);
    const bundleId = resolveBuildSetting(targetConfigs, 'PRODUCT_BUNDLE_IDENTIFIER');
    const deployTarget = resolveBuildSetting(targetConfigs, 'IPHONEOS_DEPLOYMENT_TARGET') ||
      resolveBuildSetting(targetConfigs, 'MACOSX_DEPLOYMENT_TARGET');
    const swiftVersion = resolveBuildSetting(targetConfigs, 'SWIFT_VERSION');

    let sourceFilesCount = 0;
    const sourcesPhaseId = target.buildPhases.find(id => {
      const phase = objects[id];
      return phase?.isa === 'PBXSourcesBuildPhase';
    });
    if (sourcesPhaseId) {
      const sourcesPhase = getObject<PBXSourcesBuildPhase>(objects, sourcesPhaseId);
      sourceFilesCount = sourcesPhase?.files?.length || 0;
    }

    const productTypeMap: Record<string, string> = {
      'com.apple.product-type.application': 'app',
      'com.apple.product-type.framework': 'framework',
      'com.apple.product-type.bundle.unit-test': 'unit_test',
      'com.apple.product-type.bundle.ui-testing': 'ui_test',
      'com.apple.product-type.application.watchapp2': 'watch_app',
      'com.apple.product-type.app-extension': 'extension',
    };

    targets.push({
      id: targetId,
      name: target.name,
      type: productTypeMap[target.productType] || target.productType,
      bundleId: bundleId || '',
      deploymentTarget: deployTarget || '',
      swiftVersion: swiftVersion || '',
      productType: target.productType,
      sourceFilesCount,
      configurations: targetConfigs.map(c => ({
        name: c.name,
        settings: c.buildSettings,
      })),
    });
  }

  const projectName = projectPath.replace(/\.xcodeproj$/, '').replace(/\.xcworkspace$/, '').split('/').pop() || '';
  const schemes = getSchemes(projectPath);

  return {
    name: projectName,
    path: projectPath,
    targets,
    schemes,
    configurations: configNames,
    defaultConfiguration: projectConfigs.find(c => {
      const configList = getObject<XCConfigurationList>(objects, projectObj.buildConfigurationList);
      return configList?.defaultConfigurationName === c.name;
    })?.name || configNames[0] || 'Release',
    objectVersion: parsed.objectVersion,
    developmentRegion: projectObj.developmentRegion || 'en',
  };
}

function getSchemes(projectPath: string): SchemeInfo[] {
  const projectDir = projectPath.endsWith('.xcodeproj') || projectPath.endsWith('.xcworkspace')
    ? projectPath
    : projectPath;

  const sharedSchemesDir = resolve(projectDir, 'xcshareddata', 'xcschemes');
  const xcuserdataDir = resolve(projectDir, 'xcuserdata');

  const schemes: SchemeInfo[] = [];

  try {
    if (existsSync(sharedSchemesDir)) {
      const files = readdirSync(sharedSchemesDir).filter((f: string) => f.endsWith('.xcscheme'));
      for (const file of files) {
        const name = file.replace(/\.xcscheme$/, '');
        const content = readFileSync(resolve(sharedSchemesDir, file), 'utf-8');
        const hasTests = content.includes('<TestableReference');
        const buildConfigMatch = content.match(/buildConfiguration\s*=\s*"([^"]+)"/);
        schemes.push({
          name,
          isShared: true,
          hasTests,
          buildConfiguration: buildConfigMatch?.[1] || 'Debug',
        });
      }
    }
  } catch (err) {
    logger.warn('Could not read shared schemes:', err);
  }

  // User schemes live at xcuserdata/<user>.xcuserdatad/xcschemes/<name>.xcscheme
  try {
    if (existsSync(xcuserdataDir)) {
      const userDirs = readdirSync(xcuserdataDir).filter((d: string) => d.endsWith('.xcuserdatad'));
      for (const dir of userDirs) {
        const userSchemeDir = resolve(xcuserdataDir, dir, 'xcschemes');
        if (existsSync(userSchemeDir)) {
          const files = readdirSync(userSchemeDir).filter((f: string) => f.endsWith('.xcscheme'));
          for (const file of files) {
            const name = file.replace(/\.xcscheme$/, '');
            if (!schemes.find((s: SchemeInfo) => s.name === name)) {
              schemes.push({
                name,
                isShared: false,
                hasTests: false,
                buildConfiguration: 'Debug',
              });
            }
          }
        }
      }
    }
  } catch {
    // User schemes may not exist
  }

  return schemes;
}

export function getFileEntries(projectPath: string, targetName?: string): FileEntry[] {
  const pbxprojPath = resolvePbxprojPath(projectPath);

  const parsed = parsePBXProject(pbxprojPath);
  const { objects } = parsed;
  const projectObj = getObject<import('../types/pbxproj.js').PBXProject>(objects, parsed.rootObject);
  if (!projectObj) return [];

  const entries: FileEntry[] = [];
  // fileRefId -> set of target names that include it
  const membership = new Map<string, Set<string>>();

  for (const targetId of projectObj.targets || []) {
    const target = getObject<PBXNativeTarget>(objects, targetId);
    if (!target || (targetName && target.name !== targetName)) continue;

    for (const phaseId of target.buildPhases) {
      const phase = objects[phaseId];
      if (!phase) continue;

      // Snapshot the phase file list: never mutate the array being iterated.
      let buildFileIds: string[] = [];
      if (phase.isa === 'PBXSourcesBuildPhase' || phase.isa === 'PBXResourcesBuildPhase') {
        const phaseObj = phase as PBXSourcesBuildPhase | PBXResourcesBuildPhase;
        buildFileIds = [...(phaseObj.files || [])];
      }

      for (const fileId of buildFileIds) {
        const buildFile = getObject<PBXBuildFile>(objects, fileId);
        if (buildFile?.fileRef) {
          let owners = membership.get(buildFile.fileRef);
          if (!owners) {
            owners = new Set<string>();
            membership.set(buildFile.fileRef, owners);
          }
          owners.add(target.name);
        }
      }
    }
  }

  const typeMap: Record<string, FileEntry['type']> = {
    swift: 'swift',
    m: 'objc',
    mm: 'objc',
    h: 'objc',
    cpp: 'objc',
    c: 'objc',
    storyboard: 'storyboard',
    xib: 'xib',
    xcassets: 'xcassets',
    plist: 'plist',
    strings: 'strings',
    json: 'json',
    entitlements: 'entitlements',
  };

  if (membership.size === 0) {
    // No build-phase membership found (e.g. unknown target filter): fall back
    // to listing every file reference with empty membership.
    for (const obj of Object.values(objects)) {
      if (obj?.isa === 'PBXFileReference' && (obj as PBXFileReference).path) {
        const ref = obj as PBXFileReference;
        const path = ref.path || ref.name || '';
        const ext = path.split('.').pop()?.toLowerCase() || '';
        entries.push({
          path,
          type: typeMap[ext] || 'other',
          targetMembership: [],
          sourceTree: ref.sourceTree,
        });
      }
    }
  } else {
    for (const [fileRefId, owners] of membership) {
      const ref = getObject<PBXFileReference>(objects, fileRefId);
      if (!ref) continue;
      const path = ref.path || ref.name || '';
      const ext = path.split('.').pop()?.toLowerCase() || '';
      entries.push({
        path,
        type: typeMap[ext] || 'other',
        targetMembership: [...owners].sort(),
        sourceTree: ref.sourceTree,
      });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  return entries;
}
