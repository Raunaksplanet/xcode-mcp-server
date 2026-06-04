export interface PBXObject {
  isa: string;
  [key: string]: unknown;
}

export interface PBXFileReference extends PBXObject {
  isa: 'PBXFileReference';
  explicitFileType?: string;
  lastKnownFileType?: string;
  includeInIndex?: number;
  path?: string;
  name?: string;
  sourceTree: string;
}

export interface PBXBuildFile extends PBXObject {
  isa: 'PBXBuildFile';
  fileRef: string;
  settings?: Record<string, unknown>;
}

export interface PBXGroup extends PBXObject {
  isa: 'PBXGroup' | 'PBXVariantGroup' | 'PBXFileSystemSynchronizedRootGroup';
  children: string[];
  name?: string;
  path?: string;
  sourceTree: string;
}

export interface PBXNativeTarget extends PBXObject {
  isa: 'PBXNativeTarget';
  buildConfigurationList: string;
  buildPhases: string[];
  buildRules: string[];
  dependencies: string[];
  name: string;
  productName: string;
  productReference: string;
  productType: string;
  fileSystemSynchronizedGroups?: string[];
  packageProductDependencies?: string[];
}

export interface PBXProject extends PBXObject {
  isa: 'PBXProject';
  buildConfigurationList: string;
  compatibilityVersion: string;
  developmentRegion: string;
  hasScannedForEncodings: number;
  knownRegions: string[];
  mainGroup: string;
  productRefGroup: string;
  projectDirPath: string;
  projectRoot: string;
  targets: string[];
  attributes: Record<string, unknown>;
}

export interface XCBuildConfiguration extends PBXObject {
  isa: 'XCBuildConfiguration';
  buildSettings: Record<string, string | string[] | boolean | number>;
  name: string;
  baseConfigurationReference?: string;
}

export interface XCConfigurationList extends PBXObject {
  isa: 'XCConfigurationList';
  buildConfigurations: string[];
  defaultConfigurationName: string;
  defaultConfigurationIsVisible: number;
}

export interface PBXSourcesBuildPhase extends PBXObject {
  isa: 'PBXSourcesBuildPhase';
  buildActionMask: string;
  files: string[];
  runOnlyForDeploymentPostprocessing: number;
}

export interface PBXFrameworksBuildPhase extends PBXObject {
  isa: 'PBXFrameworksBuildPhase';
  buildActionMask: string;
  files: string[];
  runOnlyForDeploymentPostprocessing: number;
}

export interface PBXResourcesBuildPhase extends PBXObject {
  isa: 'PBXResourcesBuildPhase';
  buildActionMask: string;
  files: string[];
  runOnlyForDeploymentPostprocessing: number;
}

export interface PBXShellScriptBuildPhase extends PBXObject {
  isa: 'PBXShellScriptBuildPhase';
  buildActionMask: string;
  files: string[];
  inputPaths: string[];
  outputPaths: string[];
  runOnlyForDeploymentPostprocessing: number;
  shellPath: string;
  shellScript: string;
  name?: string;
}

export type BuildPhase = PBXSourcesBuildPhase | PBXFrameworksBuildPhase | PBXResourcesBuildPhase | PBXShellScriptBuildPhase;

export interface TargetInfo {
  id: string;
  name: string;
  type: string;
  bundleId: string;
  deploymentTarget: string;
  swiftVersion: string;
  productType: string;
  sourceFilesCount: number;
  configurations: ConfigurationSetting[];
}

export interface ConfigurationSetting {
  name: string;
  settings: Record<string, string | string[] | boolean | number>;
}

export interface SchemeInfo {
  name: string;
  isShared: boolean;
  hasTests: boolean;
  buildConfiguration: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  targets: TargetInfo[];
  schemes: SchemeInfo[];
  configurations: string[];
  defaultConfiguration: string;
  objectVersion: number;
  developmentRegion: string;
}

export interface FileEntry {
  path: string;
  type: 'swift' | 'objc' | 'storyboard' | 'xcassets' | 'plist' | 'xib' | 'strings' | 'json' | 'entitlements' | 'other';
  targetMembership: string[];
  sourceTree: string;
}

export interface ParsedPBXProject {
  archiveVersion: number;
  objectVersion: number;
  classes: Record<string, unknown>;
  objects: Record<string, PBXObject>;
  rootObject: string;
}
