import { writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { parsePBXProject, resolvePbxprojPath } from './pbxproj_parser.js';
import type {
  ParsedPBXProject,
  PBXObject,
  PBXFileReference,
  PBXNativeTarget,
  PBXSourcesBuildPhase,
  PBXResourcesBuildPhase,
  PBXFrameworksBuildPhase,
  XCBuildConfiguration,
  XCRemoteSwiftPackageReference,
  XCSwiftPackageProductDependency,
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
  const pbxprojFile = resolvePbxprojPath(projectPath);

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

  const fileName = filePath.split('/').pop()!;
  if (!fileName) throw new Error(`Invalid file path: "${filePath}"`);

  // Idempotency: refuse to add a reference that already exists.
  const existing = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXFileReference' && ((obj as PBXFileReference).path === fileName || (obj as PBXFileReference).path === filePath || (obj as PBXFileReference).name === fileName)
  );
  if (existing) {
    throw new Error(`File "${fileName}" is already referenced in the project (id ${existing[0]})`);
  }

  const fileRefId = generateUUID();
  const buildFileId = generateUUID();
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

  // Add the reference to the main group so the file is visible in Xcode's
  // navigator (previously the file was only in build phases = invisible).
  const mainGroup = objects[projectObj.mainGroup] as
    | import('../types/pbxproj.js').PBXGroup
    | undefined;
  if (mainGroup && Array.isArray(mainGroup.children)) {
    if (!mainGroup.children.includes(fileRefId)) {
      mainGroup.children = [...mainGroup.children, fileRefId];
    }
  } else {
    logger.warn('Main PBXGroup not found; file added to build phases only.');
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
  const pbxprojFile = resolvePbxprojPath(projectPath);

  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const fileName = filePath.split('/').pop()!;
  if (!fileName) throw new Error(`Invalid file path: "${filePath}"`);

  // Resolve the target first: removal is scoped to it.
  const targetEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXNativeTarget' && (obj as PBXNativeTarget).name === targetName
  );
  if (!targetEntry) throw new Error(`Target "${targetName}" not found`);
  const [, target] = targetEntry as [string, PBXNativeTarget];
  const targetPhaseIds = new Set(target.buildPhases);

  // Find the file reference (match full relative path first, then basename).
  const fileRefEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXFileReference' && (obj as PBXFileReference).path === filePath
  ) || Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXFileReference' && ((obj as PBXFileReference).path === fileName || (obj as PBXFileReference).name === fileName)
  );

  if (!fileRefEntry) {
    throw new Error(`File "${fileName}" not found in project`);
  }

  const [fileRefId] = fileRefEntry;

  // Remove build-file entries referencing this file, but ONLY from the
  // requested target's phases — other targets keep their membership.
  const buildFilesToRemove: string[] = [];
  for (const [id, obj] of Object.entries(objects)) {
    if (obj?.isa === 'PBXBuildFile' && (obj as { fileRef?: string }).fileRef === fileRefId) {
      buildFilesToRemove.push(id);
    }
  }

  let removedFromTarget = false;
  for (const [id, obj] of Object.entries(objects)) {
    if (!obj || !targetPhaseIds.has(id)) continue;
    if ('files' in obj && Array.isArray((obj as unknown as { files: string[] }).files)) {
      const phase = obj as unknown as { files: string[] };
      const before = phase.files.length;
      phase.files = phase.files.filter((f: string) => !buildFilesToRemove.includes(f));
      if (phase.files.length !== before) removedFromTarget = true;
    }
  }

  if (!removedFromTarget) {
    throw new Error(`File "${fileName}" is not a member of target "${targetName}"`);
  }

  // Drop build-file objects no longer referenced by ANY phase, and the file
  // reference itself only when nothing references it anymore.
  const stillReferenced = new Set<string>();
  for (const obj of Object.values(objects)) {
    if (!obj) continue;
    if ('files' in obj && Array.isArray((obj as unknown as { files: string[] }).files)) {
      for (const f of (obj as unknown as { files: string[] }).files) stillReferenced.add(f);
    }
  }
  for (const id of buildFilesToRemove) {
    if (!stillReferenced.has(id)) delete objects[id];
  }
  const refStillUsed = Object.values(objects).some(
    (obj) => obj?.isa === 'PBXBuildFile' && (obj as { fileRef?: string }).fileRef === fileRefId
  );
  if (!refStillUsed) {
    delete objects[fileRefId];
    // Also detach from every group to avoid dangling children.
    for (const obj of Object.values(objects)) {
      if (!obj) continue;
      const group = obj as unknown as { children?: string[] };
      if (Array.isArray(group.children) && group.children.includes(fileRefId)) {
        group.children = group.children.filter((c: string) => c !== fileRefId);
      }
    }
  }

  writePBXProject(pbxprojFile, parsed);
  logger.info(`Removed file ${fileName} from target ${targetName}`);
}

export function addConfigurationList(
  projectPath: string,
  _targetId: string,
  configName: string,
  settings: Record<string, string | string[] | boolean | number>
): string {
  const pbxprojFile = resolvePbxprojPath(projectPath);

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
  const pbxprojFile = resolvePbxprojPath(projectPath);

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

  let applied = false;
  for (const configId of configList.buildConfigurations) {
    const config = objects[configId] as XCBuildConfiguration | undefined;
    if (config && config.name === configuration) {
      config.buildSettings = config.buildSettings || {};
      config.buildSettings[key] = value;
      logger.debug(`Set ${key}=${value} in ${configuration} for ${targetName}`);
      applied = true;
      break;
    }
  }

  if (!applied) {
    const available = configList.buildConfigurations
      .map((id) => (objects[id] as XCBuildConfiguration | undefined)?.name)
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `Configuration "${configuration}" not found in target "${targetName}" (available: ${available || 'none'})`
    );
  }

  writePBXProject(pbxprojFile, parsed);
  logger.info(`Set build setting ${key}=${value} in ${targetName}/${configuration}`);
}

export type SPMRequirementType =
  | 'exact'
  | 'upToNextMajorVersion'
  | 'upToNextMinorVersion'
  | 'branch'
  | 'revision';

export interface SPMRequirement {
  type: SPMRequirementType;
  value: string;
}

export interface AddSPMPackageResult {
  packageName: string;
  productName: string;
  packageId: string;
}

/**
 * Genuinely add a remote Swift package to the project: creates the
 * XCRemoteSwiftPackageReference, links its product to the target (package
 * product dependency + Frameworks build file), and registers the reference
 * on the PBXProject. Throws when the URL is already referenced.
 */
export function addSPMPackage(
  projectPath: string,
  url: string,
  requirement: SPMRequirement,
  targetName: string,
  productName?: string
): AddSPMPackageResult {
  const pbxprojFile = resolvePbxprojPath(projectPath);
  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const projectObj = parsed.objects[parsed.rootObject] as import('../types/pbxproj.js').PBXProject | undefined;
  if (!projectObj) throw new Error('Root PBXProject object not found');

  if (!requirement.value) throw new Error('Version requirement value must not be empty');
  const packageName = url.split('/').pop()?.replace(/\.git$/, '') || 'Package';
  const product = productName || packageName;

  const duplicate = Object.entries(objects).find(
    ([, obj]) =>
      obj?.isa === 'XCRemoteSwiftPackageReference' &&
      (obj as XCRemoteSwiftPackageReference).repositoryURL === url
  );
  if (duplicate) {
    throw new Error(`Package ${url} is already referenced in the project (id ${duplicate[0]})`);
  }

  const targetEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === 'PBXNativeTarget' && (obj as PBXNativeTarget).name === targetName
  );
  if (!targetEntry) throw new Error(`Target "${targetName}" not found`);
  const [, target] = targetEntry as [string, PBXNativeTarget];

  const requirementMap: Record<SPMRequirementType, () => Record<string, string>> = {
    exact: () => ({ kind: 'exact', version: requirement.value }),
    upToNextMajorVersion: () => ({ kind: 'upToNextMajorVersion', minimumVersion: requirement.value }),
    upToNextMinorVersion: () => ({ kind: 'upToNextMinorVersion', minimumVersion: requirement.value }),
    branch: () => ({ kind: 'branch', branch: requirement.value }),
    revision: () => ({ kind: 'revision', revision: requirement.value }),
  };
  const buildRequirement = requirementMap[requirement.type];
  if (!buildRequirement) throw new Error(`Unsupported requirement type: "${requirement.type}"`);

  const packageId = generateUUID();
  const packageRef: XCRemoteSwiftPackageReference = {
    isa: 'XCRemoteSwiftPackageReference',
    repositoryURL: url,
    requirement: buildRequirement(),
  };
  objects[packageId] = packageRef as unknown as PBXObject;

  const depId = generateUUID();
  const productDep: XCSwiftPackageProductDependency = {
    isa: 'XCSwiftPackageProductDependency',
    package: packageId,
    productName: product,
  };
  objects[depId] = productDep as unknown as PBXObject;

  const existingDeps = target.packageProductDependencies || [];
  target.packageProductDependencies = [...existingDeps, depId];

  // Link the product into the Frameworks phase (creating it if absent).
  let frameworksPhaseId = target.buildPhases.find((id) => objects[id]?.isa === 'PBXFrameworksBuildPhase');
  if (!frameworksPhaseId) {
    frameworksPhaseId = generateUUID();
    const frameworksPhase: PBXFrameworksBuildPhase = {
      isa: 'PBXFrameworksBuildPhase',
      buildActionMask: '2147483647',
      files: [],
      runOnlyForDeploymentPostprocessing: 0,
    };
    objects[frameworksPhaseId] = frameworksPhase as unknown as PBXObject;
    target.buildPhases = [...target.buildPhases, frameworksPhaseId];
  }
  const buildFileId = generateUUID();
  objects[buildFileId] = { isa: 'PBXBuildFile', productRef: depId } as PBXObject;
  const frameworksPhase = objects[frameworksPhaseId] as PBXFrameworksBuildPhase;
  frameworksPhase.files = [...(frameworksPhase.files || []), buildFileId];

  const refs = projectObj.packageReferences || [];
  projectObj.packageReferences = [...refs, packageId];

  writePBXProject(pbxprojFile, parsed);
  logger.info(`Added SPM package ${packageName} (${url}) to target ${targetName}`);
  return { packageName, productName: product, packageId };
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

  // Atomic write with timestamped backup: a crash mid-write must never leave
  // a truncated project.pbxproj behind.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    copyFileSync(filePath, `${filePath}.bak.${stamp}`);
  } catch {
    // First write (or unreadable original) — nothing to back up.
  }
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
  logger.debug(`Wrote ${filePath}`);
}
