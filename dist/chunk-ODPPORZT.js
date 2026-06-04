import {
  __require,
  logger
} from "./chunk-DZSLN5VB.js";

// src/lib/pbxproj_parser.ts
import { readFileSync } from "fs";
import { resolve } from "path";
function parsePBXValue(value) {
  value = value.trim();
  if (value === "YES" || value === "NO") {
    return value === "YES";
  }
  if (/^-?\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return parseFloat(value);
  }
  if (value.startsWith("(") && value.endsWith(")")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => {
      item = item.trim();
      if (item.startsWith('"') && item.endsWith('"')) {
        return item.slice(1, -1);
      }
      return item;
    });
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
function parsePBXObjectBlock(content, startIdx) {
  const obj = {};
  let i = startIdx;
  while (i < content.length) {
    if (content[i] === "}") {
      return { obj, endIdx: i + 1 };
    }
    if (content[i] === "/" && content[i + 1] === "*") {
      const endComment = content.indexOf("*/", i + 2);
      i = endComment !== -1 ? endComment + 2 : i + 2;
      continue;
    }
    if (content[i] === "/" && content[i + 1] === "/") {
      const endLine = content.indexOf("\n", i);
      i = endLine !== -1 ? endLine + 1 : content.length;
      continue;
    }
    if (/\s/.test(content[i])) {
      i++;
      continue;
    }
    if (content[i] === "}") {
      return { obj, endIdx: i + 1 };
    }
    if (content[i] === ";") {
      i++;
      continue;
    }
    const keyMatch = content.slice(i).match(/^(\w+)\s*=\s*/);
    if (keyMatch) {
      const key = keyMatch[1];
      i += keyMatch[0].length;
      if (content[i] === "{") {
        const nested = parsePBXObjectBlock(content, i + 1);
        obj[key] = parsePBXValue(String(nested.obj)) || nested.obj;
        i = nested.endIdx;
        if (content[i] === ";") i++;
        continue;
      }
      const valueMatch = content.slice(i).match(/^([^;{}]+?)\s*;/);
      if (valueMatch) {
        const raw = valueMatch[1].trim();
        obj[key] = parsePBXValue(raw);
        i += valueMatch[0].length;
        continue;
      }
      const semiIdx = content.indexOf(";", i);
      if (semiIdx !== -1) {
        const raw = content.slice(i, semiIdx).trim();
        obj[key] = parsePBXValue(raw);
        i = semiIdx + 1;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  return { obj, endIdx: i };
}
function parsePBXProject(filePath) {
  logger.debug(`Parsing pbxproj: ${filePath}`);
  const raw = readFileSync(filePath, "utf-8");
  const objectsMatch = raw.match(/objects\s*=\s*\{/);
  if (!objectsMatch) {
    throw new Error("Invalid pbxproj: no objects section found");
  }
  const startIdx = objectsMatch.index + objectsMatch[0].length;
  const objectsBlock = parsePBXObjectBlock(raw, startIdx);
  const objects = objectsBlock.obj;
  const archiveMatch = raw.match(/archiveVersion\s*=\s*(\d+)/);
  const objectVersionMatch = raw.match(/objectVersion\s*=\s*(\d+)/);
  const rootMatch = raw.match(/rootObject\s*=\s*([A-F0-9]{24})/);
  return {
    archiveVersion: archiveMatch ? parseInt(archiveMatch[1], 10) : 1,
    objectVersion: objectVersionMatch ? parseInt(objectVersionMatch[1], 10) : 0,
    classes: {},
    objects,
    rootObject: rootMatch?.[1] || ""
  };
}
function getObject(objects, id) {
  return objects[id];
}
function getBuildConfiguration(objects, configListId) {
  const configList = getObject(objects, configListId);
  if (!configList?.buildConfigurations) return [];
  return configList.buildConfigurations.map((id) => getObject(objects, id)).filter((c) => c !== void 0);
}
function resolveBuildSetting(buildConfigs, key) {
  for (const config of buildConfigs) {
    const val = config.buildSettings?.[key];
    if (val !== void 0) return String(val);
  }
  return void 0;
}
function getProjectInfo(projectPath) {
  const pbxprojPath = resolve(projectPath.endsWith(".xcodeproj") ? `${projectPath}/project.pbxproj` : projectPath);
  const parsed = parsePBXProject(pbxprojPath);
  const { objects } = parsed;
  const projectObj = getObject(objects, parsed.rootObject);
  if (!projectObj) {
    throw new Error("Root PBXProject object not found");
  }
  const projectConfigs = getBuildConfiguration(objects, projectObj.buildConfigurationList);
  const configNames = projectConfigs.map((c) => c.name).filter(Boolean);
  const targets = [];
  for (const targetId of projectObj.targets || []) {
    const target = getObject(objects, targetId);
    if (!target) continue;
    const targetConfigs = getBuildConfiguration(objects, target.buildConfigurationList);
    const bundleId = resolveBuildSetting(targetConfigs, "PRODUCT_BUNDLE_IDENTIFIER");
    const deployTarget = resolveBuildSetting(targetConfigs, "IPHONEOS_DEPLOYMENT_TARGET") || resolveBuildSetting(targetConfigs, "MACOSX_DEPLOYMENT_TARGET");
    const swiftVersion = resolveBuildSetting(targetConfigs, "SWIFT_VERSION");
    let sourceFilesCount = 0;
    const sourcesPhaseId = target.buildPhases.find((id) => {
      const phase = objects[id];
      return phase?.isa === "PBXSourcesBuildPhase";
    });
    if (sourcesPhaseId) {
      const sourcesPhase = getObject(objects, sourcesPhaseId);
      sourceFilesCount = sourcesPhase?.files?.length || 0;
    }
    const productTypeMap = {
      "com.apple.product-type.application": "app",
      "com.apple.product-type.framework": "framework",
      "com.apple.product-type.bundle.unit-test": "unit_test",
      "com.apple.product-type.bundle.ui-testing": "ui_test",
      "com.apple.product-type.application.watchapp2": "watch_app",
      "com.apple.product-type.app-extension": "extension"
    };
    targets.push({
      id: targetId,
      name: target.name,
      type: productTypeMap[target.productType] || target.productType,
      bundleId: bundleId || "",
      deploymentTarget: deployTarget || "",
      swiftVersion: swiftVersion || "",
      productType: target.productType,
      sourceFilesCount,
      configurations: targetConfigs.map((c) => ({
        name: c.name,
        settings: c.buildSettings
      }))
    });
  }
  const projectName = projectPath.replace(/\.xcodeproj$/, "").replace(/\.xcworkspace$/, "").split("/").pop() || "";
  const schemes = getSchemes(projectPath);
  return {
    name: projectName,
    path: projectPath,
    targets,
    schemes,
    configurations: configNames,
    defaultConfiguration: projectConfigs.find((c) => {
      const configList = getObject(objects, projectObj.buildConfigurationList);
      return configList?.defaultConfigurationName === c.name;
    })?.name || configNames[0] || "Release",
    objectVersion: parsed.objectVersion,
    developmentRegion: projectObj.developmentRegion || "en"
  };
}
function getSchemes(projectPath) {
  const projectDir = projectPath.endsWith(".xcodeproj") || projectPath.endsWith(".xcworkspace") ? projectPath : projectPath;
  const sharedSchemesDir = resolve(projectDir, "xcshareddata", "xcschemes");
  const userSchemesDir = resolve(projectDir, "xcuserdata");
  const { existsSync: _existsSync, readdirSync } = __require("fs");
  const schemes = [];
  try {
    if (_existsSync(sharedSchemesDir)) {
      const files = readdirSync(sharedSchemesDir).filter((f) => f.endsWith(".xcscheme"));
      for (const file of files) {
        const name = file.replace(/\.xcscheme$/, "");
        const content = readFileSync(resolve(sharedSchemesDir, file), "utf-8");
        const hasTests = content.includes("<TestableReference");
        const buildConfigMatch = content.match(/buildConfiguration\s*=\s*"([^"]+)"/);
        schemes.push({
          name,
          isShared: true,
          hasTests,
          buildConfiguration: buildConfigMatch?.[1] || "Debug"
        });
      }
    }
  } catch (err) {
    logger.warn("Could not read shared schemes:", err);
  }
  try {
    if (_existsSync(userSchemesDir)) {
      const userDirs = readdirSync(userSchemesDir).filter((d) => d.startsWith("xcschememanagement"));
      for (const dir of userDirs) {
        const userSchemeDir = resolve(userSchemesDir, dir, "xcschemes");
        if (_existsSync(userSchemeDir)) {
          const files = readdirSync(userSchemeDir).filter((f) => f.endsWith(".xcscheme"));
          for (const file of files) {
            const name = file.replace(/\.xcscheme$/, "");
            if (!schemes.find((s) => s.name === name)) {
              schemes.push({
                name,
                isShared: false,
                hasTests: false,
                buildConfiguration: "Debug"
              });
            }
          }
        }
      }
    }
  } catch {
  }
  return schemes;
}
function getFileEntries(projectPath, targetName) {
  const pbxprojPath = resolve(projectPath.endsWith(".xcodeproj") ? `${projectPath}/project.pbxproj` : projectPath);
  const parsed = parsePBXProject(pbxprojPath);
  const { objects } = parsed;
  const projectObj = getObject(objects, parsed.rootObject);
  if (!projectObj) return [];
  const entries = [];
  const targetFileRefs = /* @__PURE__ */ new Set();
  for (const targetId of projectObj.targets || []) {
    const target = getObject(objects, targetId);
    if (!target || targetName && target.name !== targetName) continue;
    for (const phaseId of target.buildPhases) {
      const phase = objects[phaseId];
      if (!phase) continue;
      let fileRefs = [];
      if (phase.isa === "PBXSourcesBuildPhase" || phase.isa === "PBXResourcesBuildPhase") {
        const phaseObj = phase;
        fileRefs = phaseObj.files || [];
      }
      for (const fileId of fileRefs) {
        const buildFile = getObject(objects, fileId);
        if (buildFile?.fileRef) {
          fileRefs.push(buildFile.fileRef);
        }
      }
    }
  }
  if (targetFileRefs.size === 0) {
    for (const obj of Object.values(objects)) {
      if (obj?.isa === "PBXFileReference" && obj.path) {
        const ref = obj;
        const path = ref.path || ref.name || "";
        const ext = path.split(".").pop()?.toLowerCase() || "";
        const typeMap = {
          swift: "swift",
          m: "objc",
          mm: "objc",
          h: "objc",
          cpp: "objc",
          c: "objc",
          storyboard: "storyboard",
          xib: "xib",
          xcassets: "xcassets",
          plist: "plist",
          strings: "strings",
          json: "json",
          entitlements: "entitlements"
        };
        entries.push({
          path,
          type: typeMap[ext] || "other",
          targetMembership: [],
          sourceTree: ref.sourceTree
        });
      }
    }
  }
  return entries;
}

export {
  parsePBXProject,
  getProjectInfo,
  getFileEntries
};
