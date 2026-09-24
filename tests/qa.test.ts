import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePBXProject,
  getProjectInfo,
  getFileEntries,
  resolvePbxprojPath,
  stripPbxComments,
} from '../src/lib/pbxproj_parser.js';
import {
  addFileToProject,
  removeFileFromProject,
  setBuildSetting,
  writePBXProject,
  addSPMPackage,
} from '../src/lib/pbxproj_writer.js';
import {
  parseBuildOutput,
  buildSucceeded,
  getBuildTime,
} from '../src/lib/xcode_runner.js';
import {
  assertPathInProject,
  requireNonEmptyString,
  requireBundleId,
  requirePayloadObject,
  parseTimeoutEnv,
  projectFlag,
  clampLines,
  clampDurationSeconds,
} from '../src/lib/validation.js';

// ---------------------------------------------------------------------------
// Fixtures: a small but realistic project.pbxproj exercising comments,
// quoted strings with semicolons, arrays, nested dicts and shared file refs.
// ---------------------------------------------------------------------------

const ID = {
  root: '111111111111111111111111',
  projectList: '222222222222222222222222',
  projectCfg: '333333333333333333333333',
  app: '444444444444444444444444',
  appList: '555555555555555555555555',
  appCfg: '666666666666666666666666',
  tests: '777777777777777777777777',
  testsList: '888888888888888888888888',
  testsCfg: '999999999999999999999999',
  srcPhase: 'AAAAAAAAAAAAAAAAAAAAAAAA',
  fwPhase: 'BBBBBBBBBBBBBBBBBBBBBBBB',
  shPhase: 'CCCCCCCCCCCCCCCCCCCCCCCC',
  srcPhase2: 'DDDDDDDDDDDDDDDDDDDDDDDD',
  buildFile1: 'E1E1E1E1E1E1E1E1E1E1E1E1',
  buildFile2: 'E2E2E2E2E2E2E2E2E2E2E2E2',
  fileRef: 'FFFFFFFFFFFFFFFFFFFFFFFF',
  mainGroup: 'ABABABABABABABABABABABAB',
  prodGroup: 'CDCDCDCDCDCDCDCDCDCDCDCD',
  productRef: '1234567890ABCDEF12345678',
};

function fixturePbxproj(): string {
  const F = ID;
  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 60;
\tobjects = {
/* Begin PBXProject section */
\t\t${F.root} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tbuildConfigurationList = ${F.projectList} /* Build configuration list for PBXProject */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${F.mainGroup};
\t\t\tproductRefGroup = ${F.prodGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${F.app} /* App */,
\t\t\t\t${F.tests} /* AppTests */,
\t\t\t);
\t\t};
/* Begin XCConfigurationList section */
\t\t${F.projectList} = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${F.projectCfg} /* Debug */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Debug;
\t\t};
\t\t${F.projectCfg} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tOTHER_CFLAGS = "-DFOO=1; -DBAR=2";
\t\t\t};
\t\t\tname = Debug;
\t\t};
/* Begin PBXNativeTarget section */
\t\t${F.app} /* App */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${F.appList} /* Build configuration list for PBXNativeTarget "App" */;
\t\t\tbuildPhases = (
\t\t\t\t${F.srcPhase} /* Sources */,
\t\t\t\t${F.fwPhase} /* Frameworks */,
\t\t\t\t${F.shPhase} /* Run Script */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = App;
\t\t\tproductName = App;
\t\t\tproductReference = ${F.productRef} /* App.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
\t\t${F.appList} = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${F.appCfg} /* Debug */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Debug;
\t\t};
\t\t${F.appCfg} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${F.tests} /* AppTests */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${F.testsList} /* Build configuration list for PBXNativeTarget "AppTests" */;
\t\t\tbuildPhases = (
\t\t\t\t${F.srcPhase2} /* Sources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = AppTests;
\t\t\tproductName = AppTests;
\t\t\tproductType = "com.apple.product-type.bundle.unit-test";
\t\t};
\t\t${F.testsList} = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${F.testsCfg} /* Debug */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Debug;
\t\t};
\t\t${F.testsCfg} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t};
\t\t\tname = Debug;
\t\t};
/* Begin PBXSourcesBuildPhase section */
\t\t${F.srcPhase} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${F.buildFile1} /* App.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
\t\t${F.srcPhase2} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${F.buildFile2} /* App.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* Begin PBXFrameworksBuildPhase section */
\t\t${F.fwPhase} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* Begin PBXShellScriptBuildPhase section */
\t\t${F.shPhase} /* Run Script */ = {
\t\t\tisa = PBXShellScriptBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\tinputPaths = (
\t\t\t);
\t\t\toutputPaths = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t\tshellPath = /bin/sh;
\t\t\tshellScript = "echo hi; echo bye";
\t\t};
/* Begin PBXBuildFile section */
\t\t${F.buildFile1} /* App.swift in Sources */ = {
\t\t\tisa = PBXBuildFile;
\t\t\tfileRef = ${F.fileRef} /* App.swift */;
\t\t};
\t\t${F.buildFile2} /* App.swift in Sources */ = {
\t\t\tisa = PBXBuildFile;
\t\t\tfileRef = ${F.fileRef} /* App.swift */;
\t\t};
/* Begin PBXFileReference section */
\t\t${F.fileRef} /* App.swift */ = {
\t\t\tisa = PBXFileReference;
\t\t\tlastKnownFileType = sourcecode.swift;
\t\t\tpath = App.swift;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${F.productRef} /* App.app */ = {
\t\t\tisa = PBXFileReference;
\t\t\texplicitFileType = wrapper.application;
\t\t\tpath = App.app;
\t\t\tsourceTree = BUILT_PRODUCTS_DIR;
\t\t};
/* Begin PBXGroup section */
\t\t${F.mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${F.fileRef} /* App.swift */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${F.prodGroup} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${F.productRef} /* App.app */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t};
\trootObject = ${F.root} /* Project object */;
}
`;
}

let workdir = '';
let xcodeproj = '';

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'xcode-mcp-qa-'));
  xcodeproj = join(workdir, 'Demo.xcodeproj');
  mkdirSync(xcodeproj, { recursive: true });
  writeFileSync(join(xcodeproj, 'project.pbxproj'), fixturePbxproj(), 'utf-8');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function phaseFiles(projectPath: string, phaseId: string): string[] {
  const parsed = parsePBXProject(join(projectPath, 'project.pbxproj'));
  const phase = parsed.objects[phaseId] as unknown as { files?: string[] } | undefined;
  return phase?.files || [];
}

// ---------------------------------------------------------------------------
// pbxproj parser
// ---------------------------------------------------------------------------

describe('pbxproj parser', () => {
  it('captures object IDs annotated with comments', () => {
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    assert.equal(Object.keys(parsed.objects).length, 19);
    assert.equal(parsed.rootObject, ID.root);
    const target = parsed.objects[ID.app] as unknown as { name?: string };
    assert.equal(target?.name, 'App');
  });

  it('preserves nested dicts and quoted strings containing semicolons', () => {
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    const cfg = parsed.objects[ID.projectCfg] as unknown as { buildSettings?: Record<string, unknown> };
    assert.equal(cfg.buildSettings?.['OTHER_CFLAGS'], '-DFOO=1; -DBAR=2');
    assert.equal(cfg.buildSettings?.['PRODUCT_NAME'], '$(TARGET_NAME)');
    const script = parsed.objects[ID.shPhase] as unknown as { shellScript?: string };
    assert.equal(script.shellScript, 'echo hi; echo bye');
  });

  it('parses arrays with comments and empty arrays', () => {
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    const group = parsed.objects[ID.mainGroup] as unknown as { children?: string[] };
    assert.deepEqual(group.children, [ID.fileRef]);
    const target = parsed.objects[ID.app] as unknown as { dependencies?: string[] };
    assert.deepEqual(target.dependencies, []);
  });

  it('keeps all-digit object references as strings (no float mangling)', () => {
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    const app = parsed.objects[ID.app] as unknown as { buildConfigurationList?: unknown };
    assert.equal(app.buildConfigurationList, ID.appList);
    const list = parsed.objects[ID.appList] as unknown as { buildConfigurations?: unknown };
    assert.deepEqual(list.buildConfigurations, [ID.appCfg]);
  });

  it('stripPbxComments preserves comment markers inside quoted strings', () => {
    const out = stripPbxComments('a = "x /* keep */ y"; /* drop */ b = 1;');
    assert.ok(out.includes('/* keep */'));
    assert.ok(!out.includes('drop'));
  });

  it('getProjectInfo reports targets, bundle id and configurations', () => {
    const info = getProjectInfo(xcodeproj);
    assert.equal(info.targets.length, 2);
    const app = info.targets.find((t) => t.name === 'App');
    assert.equal(app?.bundleId, 'com.example.app');
    assert.equal(app?.sourceFilesCount, 1);
    assert.deepEqual(info.configurations, ['Debug']);
  });

  it('getFileEntries reports target membership for shared files', () => {
    const entries = getFileEntries(xcodeproj);
    const app = entries.find((e) => e.path === 'App.swift');
    assert.deepEqual(app?.targetMembership, ['App', 'AppTests']);
    const scoped = getFileEntries(xcodeproj, 'App');
    assert.deepEqual(scoped.find((e) => e.path === 'App.swift')?.targetMembership, ['App']);
  });

  it('resolvePbxprojPath finds the project next to a workspace', () => {
    const ws = join(workdir, 'Demo.xcworkspace');
    mkdirSync(ws, { recursive: true });
    assert.equal(resolvePbxprojPath(ws), join(xcodeproj, 'project.pbxproj'));
  });

  it('rejects files without an objects section', () => {
    const bad = join(workdir, 'bad.pbxproj');
    writeFileSync(bad, '// !$*UTF8*$!\n{ archiveVersion = 1; }\n', 'utf-8');
    assert.throws(() => parsePBXProject(bad), /no objects section/);
  });
});

// ---------------------------------------------------------------------------
// pbxproj writer
// ---------------------------------------------------------------------------

describe('pbxproj writer', () => {
  it('addFileToProject registers reference, build file and group child', () => {
    addFileToProject(xcodeproj, 'New.swift', 'App');
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    const ref = Object.values(parsed.objects).find(
      (o) => o?.isa === 'PBXFileReference' && (o as unknown as { path?: string }).path === 'New.swift'
    );
    assert.ok(ref, 'file reference created');
    const files = phaseFiles(xcodeproj, ID.srcPhase);
    assert.equal(files.length, 2);
    const group = parsed.objects[ID.mainGroup] as unknown as { children?: string[] };
    assert.equal(group.children?.length, 2);
  });

  it('addFileToProject refuses duplicates', () => {
    assert.throws(() => addFileToProject(xcodeproj, 'App.swift', 'App'), /already referenced/);
  });

  it('addFileToProject rejects unknown targets', () => {
    assert.throws(() => addFileToProject(xcodeproj, 'New.swift', 'Nope'), /Target "Nope" not found/);
  });

  it('removeFileFromProject is scoped to the requested target', () => {
    removeFileFromProject(xcodeproj, 'App.swift', 'AppTests');
    assert.deepEqual(phaseFiles(xcodeproj, ID.srcPhase2), []);
    assert.equal(phaseFiles(xcodeproj, ID.srcPhase).length, 1);
    // Still referenced by App: the file reference must survive.
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    assert.ok(parsed.objects[ID.fileRef], 'shared file reference kept');
    // Removing from a non-member target fails loudly.
    assert.throws(() => removeFileFromProject(xcodeproj, 'App.swift', 'AppTests'), /not a member/);
    // Removing the last membership drops the reference and group child.
    removeFileFromProject(xcodeproj, 'App.swift', 'App');
    const reparsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    assert.ok(!reparsed.objects[ID.fileRef], 'orphan reference removed');
    const group = reparsed.objects[ID.mainGroup] as unknown as { children?: string[] };
    assert.ok(!group.children?.includes(ID.fileRef), 'group child detached');
  });

  it('setBuildSetting writes and throws on unknown configuration', () => {
    setBuildSetting(xcodeproj, 'App', 'Debug', 'SWIFT_VERSION', '5.9');
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    const cfg = parsed.objects[ID.appCfg] as unknown as { buildSettings?: Record<string, unknown> };
    assert.equal(String(cfg.buildSettings?.['SWIFT_VERSION']), '5.9');
    assert.throws(() => setBuildSetting(xcodeproj, 'App', 'Release', 'FOO', 'bar'), /Configuration "Release" not found/);
    assert.throws(() => setBuildSetting(xcodeproj, 'Nope', 'Debug', 'FOO', 'bar'), /Target "Nope" not found/);
  });

  it('writePBXProject leaves a backup and round-trips content', () => {
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    writePBXProject(join(xcodeproj, 'project.pbxproj'), parsed);
    const backups = readdirSync(xcodeproj).filter((f) => f.startsWith('project.pbxproj.bak.'));
    assert.equal(backups.length, 1);
    const reparsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    assert.equal(Object.keys(reparsed.objects).length, 19);
    const script = reparsed.objects[ID.shPhase] as unknown as { shellScript?: string };
    assert.equal(script.shellScript, 'echo hi; echo bye');
  });

  it('addSPMPackage inserts reference, product dep and links the target', () => {
    const added = addSPMPackage(xcodeproj, 'https://github.com/example/Package.git', {
      type: 'upToNextMajorVersion',
      value: '1.0.0',
    }, 'App');
    assert.equal(added.packageName, 'Package');
    const parsed = parsePBXProject(join(xcodeproj, 'project.pbxproj'));
    const refs = Object.values(parsed.objects).filter((o) => o?.isa === 'XCRemoteSwiftPackageReference');
    assert.equal(refs.length, 1);
    const target = parsed.objects[ID.app] as unknown as { packageProductDependencies?: string[] };
    assert.equal(target.packageProductDependencies?.length, 1);
    const project = parsed.objects[ID.root] as unknown as { packageReferences?: string[] };
    assert.equal(project.packageReferences?.length, 1);
    assert.throws(
      () => addSPMPackage(xcodeproj, 'https://github.com/example/Package.git', { type: 'branch', value: 'main' }, 'App'),
      /already referenced/
    );
  });
});

// ---------------------------------------------------------------------------
// build output parsing
// ---------------------------------------------------------------------------

describe('build output parsing', () => {
  it('captures file, line, column and message', () => {
    const { errors, warnings } = parseBuildOutput(
      '/tmp/App.swift:12:8: error: cannot find foo in scope\n' +
      '/tmp/App.swift:20:5: warning: unused variable x\n' +
      '/tmp/App.swift:21:3: note: did you mean y?\n',
      ''
    );
    assert.equal(errors.length, 2); // error + note
    assert.equal(errors[0]?.file, '/tmp/App.swift');
    assert.equal(errors[0]?.line, 12);
    assert.equal(errors[0]?.column, 8);
    assert.equal(warnings[0]?.column, 5);
  });

  it('captures fatal and linker errors without file prefixes', () => {
    const { errors } = parseBuildOutput('fatal error: unexpectedly found nil\nld: library not found for -lFoo\n', '');
    assert.equal(errors.length, 2);
  });

  it('buildSucceeded honours stderr too', () => {
    assert.ok(buildSucceeded('', 'BUILD SUCCEEDED'));
    assert.ok(!buildSucceeded('BUILD FAILED', ''));
  });

  it('getBuildTime parses xcodebuild timing', () => {
    assert.ok(getBuildTime('... 12.5 seconds (xcodebuild)') > 12);
    assert.equal(getBuildTime('nothing here'), 0);
  });
});

// ---------------------------------------------------------------------------
// validation helpers
// ---------------------------------------------------------------------------

function throwsCode(fn: () => unknown, code: string): void {
  // Validation helpers throw plain MCPError-shaped objects, which stringify
  // to "[object Object]" — assert on the .code property instead of regex.
  assert.throws(fn, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code);
    return true;
  });
}

describe('validation', () => {
  it('assertPathInProject blocks sibling-prefix escapes and allows legit paths', () => {
    const base = join(workdir, 'proj');
    mkdirSync(base, { recursive: true });
    assert.equal(assertPathInProject(base, 'Sources/A.swift'), join(base, 'Sources/A.swift'));
    throwsCode(() => assertPathInProject(base, '../proj-evil/x'), 'PATH_TRAVERSAL');
    throwsCode(() => assertPathInProject(base, ''), 'INVALID_INPUT');
  });

  it('requireNonEmptyString / requireBundleId / requirePayloadObject', () => {
    assert.equal(requireNonEmptyString('  x  ', 'f'), 'x');
    throwsCode(() => requireNonEmptyString('   ', 'f'), 'INVALID_INPUT');
    assert.equal(requireBundleId('com.example.App', 'b'), 'com.example.App');
    throwsCode(() => requireBundleId('not a bundle', 'b'), 'INVALID_INPUT');
    assert.deepEqual(requirePayloadObject({ aps: {} }, 'p'), { aps: {} });
    throwsCode(() => requirePayloadObject([], 'p'), 'INVALID_INPUT');
  });

  it('parseTimeoutEnv falls back on garbage and clamps range', () => {
    assert.equal(parseTimeoutEnv(undefined, 300), 300);
    assert.equal(parseTimeoutEnv('abc', 300), 300);
    assert.equal(parseTimeoutEnv('0', 300), 300);
    assert.equal(parseTimeoutEnv('99999', 300), 300);
    assert.equal(parseTimeoutEnv('120', 300), 120);
  });

  it('projectFlag distinguishes workspaces', () => {
    assert.deepEqual(projectFlag('/a/B.xcworkspace'), ['-workspace', '/a/B.xcworkspace']);
    assert.deepEqual(projectFlag('/a/B.xcodeproj'), ['-project', '/a/B.xcodeproj']);
  });

  it('clampLines / clampDurationSeconds enforce bounds', () => {
    assert.equal(clampLines(undefined, 100), 100);
    assert.equal(clampDurationSeconds(30, 10), 30);
    throwsCode(() => clampLines(0, 100), 'INVALID_INPUT');
    throwsCode(() => clampDurationSeconds(9999, 10), 'INVALID_INPUT');
  });
});
