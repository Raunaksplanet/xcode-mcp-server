import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { parsePBXProject } from './pbxproj_parser.js';
import type {
  ParsedPBXProject,
  PBXObject,
  PBXFileReference,
  PBXNativeTarget,
  PBXSourcesBuildPhase,
  PBXResourcesBuildPhase,
  XCBuildConfiguration,
} from '../types/pbxproj.js';

function generateUUID(): string {
  const hex = randomUUID().replace(/-/g, '').toUpperCase();
  return hex.slice(0, 24);
}

function serializePBXValue(value: unknown, indent = '\t'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '(\n)';
    return `(\n${value.map(v => `${indent}${serializePBXValue(v, indent + '\t')},\n`).join('')}${indent.slice(0, -1)})`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined);
    if (entries.length === 0) return '{\n}';
    return `{\n${entries.map(([k, v]) => `${indent}${k} = ${serializePBXValue(v, indent + '\t')};\n`).join('')}${indent.slice(0, -1)}}`;
  }
  const str = String(value);
  if (str.includes(' ') || str.includes('/*') || str.includes('*/') || str.includes(';') || str.includes('{') || str.includes('}')) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

function serializeObjects(objects: Record<string, PBXObject>): string {
  const sortedKeys = Object.keys(objects).sort();
  const sections = new Map<string, string[]>();

  for (const key of sortedKeys) {
    const obj = objects[key]!;
    const isa = obj.isa;
    const sectionName = `Begin ${isa} section`;
    if (!sections.has(sectionName)) {
      sections.set(sectionName, []);
    }
    const comment = (obj as PBXFileReference).name || (obj as PBXFileReference).path || '';
    const serialized = serializePBXValue(obj, '\t\t');
    sections.get(sectionName)!.push(`\t\t${key}${comment ? ` /* ${comment} */` : ''} = ${serialized};`);
  }

  const result: string[] = [];
  for (const [header, items] of sections) {
    const sectionName = header.replace('Begin ', '').replace(' section', '');
    result.push(`/* ${header} */`);
    result.push(...items);
    result.push(`/* End ${sectionName} section */`);
    result.push('');
  }

  return result.join('\n');
}

export function addFileToProject(
  projectPath: string,
  filePath: string,
  targetName: string,
  _content?: string
): void {
  const pbxprojFile = projectPath.endsWith('.xcodeproj')
    ? resolve(projectPath, 'project.pbxproj')
    : projectPath;

  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const projectObj = parsed.objects[parsed.rootObject] as import('../types/pbxproj.js').PBXProject | undefined;
  if (!projectObj) throw new Error('Root PBXProject object not found');

  // Find target
  const targetEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXNativeTarget' && (obj as PBXNativeTarget).name === targetName
  );
  if (!targetEntry) throw new Error(`Target "${targetName}" not found`);
  const [, target] = targetEntry as [string, PBXNativeTarget];

  const fileRefId = generateUUID();
  const buildFileId = generateUUID();
  const fileName = filePath.split('/').pop()!;
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  const lastKnownFileTypeMap: Record<string, string> = {
    swift: 'sourcecode.swift',
    m: 'sourcecode.c.objc',
    mm: 'sourcecode.cpp.objcpp',
    h: 'sourcecode.c.h',
    c: 'sourcecode.c.c',
    cpp: 'sourcecode.cpp.cpp',
    storyboard: 'file.storyboard',
    xib: 'file.xib',
    xcassets: 'folder.assetcatalog',
    plist: 'text.plist.xml',
    strings: 'text.plist.strings',
    json: 'text.json',
    entitlements: 'text.plist.entitlements',
  };

  // Add PBXFileReference
  const fileRef: PBXFileReference = {
    isa: 'PBXFileReference',
    lastKnownFileType: lastKnownFileTypeMap[ext] || 'file',
    path: fileName,
    sourceTree: '<group>',
  };

  if (ext === 'xcassets') {
    fileRef.explicitFileType = 'folder.assetcatalog';
    delete fileRef.lastKnownFileType;
  }

  objects[fileRefId] = fileRef as unknown as PBXObject;

  // Add PBXBuildFile
  const buildFile: PBXObject = {
    isa: 'PBXBuildFile',
    fileRef: fileRefId,
  } as PBXObject;
  objects[buildFileId] = buildFile;

  // Add file to appropriate build phase
  const sourceExts = new Set(['swift', 'm', 'mm', 'c', 'cpp', 'cxx']);
  const resourceExts = new Set(['storyboard', 'xib', 'xcassets', 'strings', 'json', 'plist', 'entitlements']);

  for (const phaseId of target.buildPhases) {
    const phase = objects[phaseId];
    if (!phase) continue;

    if (sourceExts.has(ext) && phase.isa === 'PBXSourcesBuildPhase') {
      const sourcesPhase = phase as PBXSourcesBuildPhase;
      sourcesPhase.files = [...(sourcesPhase.files || []), buildFileId];
      logger.debug(`Added ${fileName} to Sources build phase of ${targetName}`);
    } else if (resourceExts.has(ext) && phase.isa === 'PBXResourcesBuildPhase') {
      const resourcesPhase = phase as PBXResourcesBuildPhase;
      resourcesPhase.files = [...(resourcesPhase.files || []), buildFileId];
      logger.debug(`Added ${fileName} to Resources build phase of ${targetName}`);
    }
  }

  // Write updated project.pbxproj
  writePBXProject(pbxprojFile, parsed);
  logger.info(`Added file ${fileName} to project ${targetName}`);
}

export function removeFileFromProject(
  projectPath: string,
  filePath: string,
  targetName: string
): void {
  const pbxprojFile = projectPath.endsWith('.xcodeproj')
    ? resolve(projectPath, 'project.pbxproj')
    : projectPath;

  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const fileName = filePath.split('/').pop()!;

  // Find the file reference
  const fileRefEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXFileReference' && ((obj as PBXFileReference).path === fileName || (obj as PBXFileReference).name === fileName)
  );

  if (!fileRefEntry) {
    throw new Error(`File "${fileName}" not found in project`);
  }

  const [fileRefId] = fileRefEntry;

  // Find and remove build file entries referencing this file
  const buildFilesToRemove: string[] = [];
  for (const [id, obj] of Object.entries(objects)) {
    if (obj?.isa === 'PBXBuildFile' && (obj as { fileRef?: string }).fileRef === fileRefId) {
      buildFilesToRemove.push(id);
    }
  }

  for (const obj of Object.values(objects)) {
    if (!obj) continue;
    if ('files' in obj && Array.isArray((obj as unknown as { files: string[] }).files)) {
      const phase = obj as unknown as { files: string[] };
      phase.files = phase.files.filter((f: string) => !buildFilesToRemove.includes(f));
    }
  }

  // Remove objects
  for (const id of buildFilesToRemove) {
    delete objects[id];
  }
  delete objects[fileRefId];

  writePBXProject(pbxprojFile, parsed);
  logger.info(`Removed file ${fileName} from project ${targetName}`);
}

export function addConfigurationList(
  projectPath: string,
  _targetId: string,
  configName: string,
  settings: Record<string, string | string[] | boolean | number>
): string {
  const pbxprojFile = projectPath.endsWith('.xcodeproj')
    ? resolve(projectPath, 'project.pbxproj')
    : projectPath;

  const parsed = parsePBXProject(pbxprojFile);
  const configId = generateUUID();

  const config: XCBuildConfiguration = {
    isa: 'XCBuildConfiguration',
    buildSettings: settings,
    name: configName,
  };

  parsed.objects[configId] = config as unknown as PBXObject;
  writePBXProject(pbxprojFile, parsed);
  return configId;
}

export function setBuildSetting(
  projectPath: string,
  targetName: string,
  configuration: string,
  key: string,
  value: string
): void {
  const pbxprojFile = projectPath.endsWith('.xcodeproj')
    ? resolve(projectPath, 'project.pbxproj')
    : projectPath;

  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;

  const targetEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXNativeTarget' && (obj as PBXNativeTarget).name === targetName
  );
  if (!targetEntry) throw new Error(`Target "${targetName}" not found`);
  const [, target] = targetEntry as [string, PBXNativeTarget];

  const configs = target.buildConfigurationList;
  const configList = objects[configs] as { buildConfigurations?: string[] } | undefined;
  if (!configList?.buildConfigurations) throw new Error('No build configurations found');

  for (const configId of configList.buildConfigurations) {
    const config = objects[configId] as XCBuildConfiguration | undefined;
    if (config && config.name === configuration) {
      config.buildSettings[key] = value;
      logger.debug(`Set ${key}=${value} in ${configuration} for ${targetName}`);
      break;
    }
  }

  writePBXProject(pbxprojFile, parsed);
  logger.info(`Set build setting ${key}=${value} in ${targetName}/${configuration}`);
}

export function writePBXProject(filePath: string, parsed: ParsedPBXProject): void {
  const objectsSerialized = serializeObjects(parsed.objects);

  const content = `// !$*UTF8*$!
{
\tarchiveVersion = ${parsed.archiveVersion};
\tclasses = {
\t};
\tobjectVersion = ${parsed.objectVersion};
\tobjects = {
${objectsSerialized}\t};
\trootObject = ${parsed.rootObject} /* Project object */;
}
`;

  writeFileSync(filePath, content, 'utf-8');
  logger.debug(`Wrote ${filePath}`);
}
