import {
  parsePBXProject
} from "./chunk-ODPPORZT.js";
import {
  logger
} from "./chunk-DZSLN5VB.js";

// src/lib/pbxproj_writer.ts
import { writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
function generateUUID() {
  const hex = randomUUID().replace(/-/g, "").toUpperCase();
  return hex.slice(0, 24);
}
function serializePBXValue(value, indent = "	") {
  if (value === null || value === void 0) return "";
  if (typeof value === "boolean") return value ? "YES" : "NO";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(\n)";
    return `(
${value.map((v) => `${indent}${serializePBXValue(v, indent + "	")},
`).join("")}${indent.slice(0, -1)})`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== null && v !== void 0);
    if (entries.length === 0) return "{\n}";
    return `{
${entries.map(([k, v]) => `${indent}${k} = ${serializePBXValue(v, indent + "	")};
`).join("")}${indent.slice(0, -1)}}`;
  }
  const str = String(value);
  if (str.includes(" ") || str.includes("/*") || str.includes("*/") || str.includes(";") || str.includes("{") || str.includes("}")) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}
function serializeObjects(objects) {
  const sortedKeys = Object.keys(objects).sort();
  const sections = /* @__PURE__ */ new Map();
  for (const key of sortedKeys) {
    const obj = objects[key];
    const isa = obj.isa;
    const sectionName = `Begin ${isa} section`;
    if (!sections.has(sectionName)) {
      sections.set(sectionName, []);
    }
    const comment = obj.name || obj.path || "";
    const serialized = serializePBXValue(obj, "		");
    sections.get(sectionName).push(`		${key}${comment ? ` /* ${comment} */` : ""} = ${serialized};`);
  }
  const result = [];
  for (const [header, items] of sections) {
    const sectionName = header.replace("Begin ", "").replace(" section", "");
    result.push(`/* ${header} */`);
    result.push(...items);
    result.push(`/* End ${sectionName} section */`);
    result.push("");
  }
  return result.join("\n");
}
function addFileToProject(projectPath, filePath, targetName, _content) {
  const pbxprojFile = projectPath.endsWith(".xcodeproj") ? resolve(projectPath, "project.pbxproj") : projectPath;
  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const projectObj = parsed.objects[parsed.rootObject];
  if (!projectObj) throw new Error("Root PBXProject object not found");
  const targetEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === "PBXNativeTarget" && obj.name === targetName
  );
  if (!targetEntry) throw new Error(`Target "${targetName}" not found`);
  const [, target] = targetEntry;
  const fileRefId = generateUUID();
  const buildFileId = generateUUID();
  const fileName = filePath.split("/").pop();
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const lastKnownFileTypeMap = {
    swift: "sourcecode.swift",
    m: "sourcecode.c.objc",
    mm: "sourcecode.cpp.objcpp",
    h: "sourcecode.c.h",
    c: "sourcecode.c.c",
    cpp: "sourcecode.cpp.cpp",
    storyboard: "file.storyboard",
    xib: "file.xib",
    xcassets: "folder.assetcatalog",
    plist: "text.plist.xml",
    strings: "text.plist.strings",
    json: "text.json",
    entitlements: "text.plist.entitlements"
  };
  const fileRef = {
    isa: "PBXFileReference",
    lastKnownFileType: lastKnownFileTypeMap[ext] || "file",
    path: fileName,
    sourceTree: "<group>"
  };
  if (ext === "xcassets") {
    fileRef.explicitFileType = "folder.assetcatalog";
    delete fileRef.lastKnownFileType;
  }
  objects[fileRefId] = fileRef;
  const buildFile = {
    isa: "PBXBuildFile",
    fileRef: fileRefId
  };
  objects[buildFileId] = buildFile;
  const sourceExts = /* @__PURE__ */ new Set(["swift", "m", "mm", "c", "cpp", "cxx"]);
  const resourceExts = /* @__PURE__ */ new Set(["storyboard", "xib", "xcassets", "strings", "json", "plist", "entitlements"]);
  for (const phaseId of target.buildPhases) {
    const phase = objects[phaseId];
    if (!phase) continue;
    if (sourceExts.has(ext) && phase.isa === "PBXSourcesBuildPhase") {
      const sourcesPhase = phase;
      sourcesPhase.files = [...sourcesPhase.files || [], buildFileId];
      logger.debug(`Added ${fileName} to Sources build phase of ${targetName}`);
    } else if (resourceExts.has(ext) && phase.isa === "PBXResourcesBuildPhase") {
      const resourcesPhase = phase;
      resourcesPhase.files = [...resourcesPhase.files || [], buildFileId];
      logger.debug(`Added ${fileName} to Resources build phase of ${targetName}`);
    }
  }
  writePBXProject(pbxprojFile, parsed);
  logger.info(`Added file ${fileName} to project ${targetName}`);
}
function removeFileFromProject(projectPath, filePath, targetName) {
  const pbxprojFile = projectPath.endsWith(".xcodeproj") ? resolve(projectPath, "project.pbxproj") : projectPath;
  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const fileName = filePath.split("/").pop();
  const fileRefEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === "PBXFileReference" && (obj.path === fileName || obj.name === fileName)
  );
  if (!fileRefEntry) {
    throw new Error(`File "${fileName}" not found in project`);
  }
  const [fileRefId] = fileRefEntry;
  const buildFilesToRemove = [];
  for (const [id, obj] of Object.entries(objects)) {
    if (obj?.isa === "PBXBuildFile" && obj.fileRef === fileRefId) {
      buildFilesToRemove.push(id);
    }
  }
  for (const obj of Object.values(objects)) {
    if (!obj) continue;
    if ("files" in obj && Array.isArray(obj.files)) {
      const phase = obj;
      phase.files = phase.files.filter((f) => !buildFilesToRemove.includes(f));
    }
  }
  for (const id of buildFilesToRemove) {
    delete objects[id];
  }
  delete objects[fileRefId];
  writePBXProject(pbxprojFile, parsed);
  logger.info(`Removed file ${fileName} from project ${targetName}`);
}
function addConfigurationList(projectPath, _targetId, configName, settings) {
  const pbxprojFile = projectPath.endsWith(".xcodeproj") ? resolve(projectPath, "project.pbxproj") : projectPath;
  const parsed = parsePBXProject(pbxprojFile);
  const configId = generateUUID();
  const config = {
    isa: "XCBuildConfiguration",
    buildSettings: settings,
    name: configName
  };
  parsed.objects[configId] = config;
  writePBXProject(pbxprojFile, parsed);
  return configId;
}
function setBuildSetting(projectPath, targetName, configuration, key, value) {
  const pbxprojFile = projectPath.endsWith(".xcodeproj") ? resolve(projectPath, "project.pbxproj") : projectPath;
  const parsed = parsePBXProject(pbxprojFile);
  const { objects } = parsed;
  const targetEntry = Object.entries(objects).find(
    ([, obj]) => obj?.isa === "PBXNativeTarget" && obj.name === targetName
  );
  if (!targetEntry) throw new Error(`Target "${targetName}" not found`);
  const [, target] = targetEntry;
  const configs = target.buildConfigurationList;
  const configList = objects[configs];
  if (!configList?.buildConfigurations) throw new Error("No build configurations found");
  for (const configId of configList.buildConfigurations) {
    const config = objects[configId];
    if (config && config.name === configuration) {
      config.buildSettings[key] = value;
      logger.debug(`Set ${key}=${value} in ${configuration} for ${targetName}`);
      break;
    }
  }
  writePBXProject(pbxprojFile, parsed);
  logger.info(`Set build setting ${key}=${value} in ${targetName}/${configuration}`);
}
function writePBXProject(filePath, parsed) {
  const objectsSerialized = serializeObjects(parsed.objects);
  const content = `// !$*UTF8*$!
{
	archiveVersion = ${parsed.archiveVersion};
	classes = {
	};
	objectVersion = ${parsed.objectVersion};
	objects = {
${objectsSerialized}	};
	rootObject = ${parsed.rootObject} /* Project object */;
}
`;
  writeFileSync(filePath, content, "utf-8");
  logger.debug(`Wrote ${filePath}`);
}

export {
  addFileToProject,
  removeFileFromProject,
  addConfigurationList,
  setBuildSetting,
  writePBXProject
};
