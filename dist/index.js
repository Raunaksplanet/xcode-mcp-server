#!/usr/bin/env node
import {
  addFileToProject,
  removeFileFromProject,
  setBuildSetting
} from "./chunk-27WY326M.js";
import {
  getFileEntries,
  getProjectInfo
} from "./chunk-ODPPORZT.js";
import {
  bootSimulator,
  buildFailed,
  fileNotFound,
  findSimulator,
  getAvailableSimulators,
  getSimulatorLogs,
  installApp,
  launchApp,
  openURL,
  pathTraversalDetected,
  pushNotification,
  recordSimulator,
  resetSimulator,
  screenshotSimulator,
  setSimulatorLocation,
  shutdownSimulator,
  terminateApp,
  testFailure
} from "./chunk-5D47YJ7S.js";
import {
  archiveBuild,
  getBuildSettings,
  killAllChildProcesses,
  parseBuildOutput,
  runAnalyze,
  runBuild,
  xcodebuild,
  xcrun
} from "./chunk-TB6DDJUC.js";
import {
  logger,
  setLogLevel
} from "./chunk-DZSLN5VB.js";

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// src/lib/config.ts
import { existsSync } from "fs";
import { readFile, access } from "fs/promises";
import { resolve as resolvePath, join } from "path";
function validateProjectPath(rawPath) {
  const resolved = resolvePath(rawPath);
  if (!existsSync(resolved)) {
    throw new Error(
      `XCODE_PROJECT_PATH not found at: ${resolved}
Set the correct path in your environment or .env file.
Expected a .xcodeproj or .xcworkspace directory.`
    );
  }
  const isValid = resolved.endsWith(".xcodeproj") || resolved.endsWith(".xcworkspace") || existsSync(join(resolved, "project.pbxproj"));
  if (!isValid) {
    throw new Error(
      `Path is not a valid Xcode project: ${resolved}
XCODE_PROJECT_PATH must point to a .xcodeproj or .xcworkspace directory.`
    );
  }
  return resolved;
}
async function loadProjectConfig(projectDir) {
  const configPath = join(projectDir, ".xcode-mcp.json");
  try {
    await access(configPath);
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}
async function loadConfig() {
  const projectPathRaw = process.env.XCODE_PROJECT_PATH;
  if (!projectPathRaw) {
    throw new Error(
      "XCODE_PROJECT_PATH environment variable is required.\nSet it to the path of your .xcodeproj or .xcworkspace, e.g.:\n  export XCODE_PROJECT_PATH=/path/to/YourApp.xcodeproj\nOr create an .env file and set it there."
    );
  }
  const projectPath = validateProjectPath(projectPathRaw);
  const projectDir = projectPath.endsWith(".xcodeproj") || projectPath.endsWith(".xcworkspace") ? resolvePath(projectPath, "..") : projectPath;
  const projectConfig = await loadProjectConfig(projectDir);
  const defaultScheme = process.env.XCODE_DEFAULT_SCHEME || projectConfig.default_scheme;
  if (!defaultScheme) {
    logger.warn("No default scheme configured. Set XCODE_DEFAULT_SCHEME or add default_scheme to .xcode-mcp.json");
  }
  return {
    projectPath,
    projectDir,
    defaultScheme: defaultScheme || "",
    defaultSimulator: process.env.XCODE_DEFAULT_SIMULATOR || projectConfig.default_simulator,
    derivedDataPath: process.env.XCODE_DERIVED_DATA_PATH,
    buildTimeout: parseInt(process.env.XCODE_MCP_BUILD_TIMEOUT || "300", 10),
    testTimeout: parseInt(process.env.XCODE_MCP_TEST_TIMEOUT || "600", 10),
    projectConfig
  };
}

// src/tools/project.ts
import { existsSync as existsSync2 } from "fs";
import { resolve as resolvePath2 } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
function assertPathInProject(projectDir, filePath) {
  const resolved = resolvePath2(projectDir, filePath);
  if (!resolved.startsWith(projectDir)) {
    throw pathTraversalDetected(filePath);
  }
  return resolved;
}
function registerProjectTools(server) {
  const config = server.config;
  server.registerTool({
    name: "xcode_open_project",
    description: "Open .xcodeproj or .xcworkspace in Xcode via osascript",
    inputSchema: {
      type: "object",
      properties: {
        project_path: {
          type: "string",
          description: "Path to .xcodeproj or .xcworkspace (defaults to XCODE_PROJECT_PATH)"
        }
      }
    },
    handler: async (args) => {
      const projectPath = args.project_path || config.projectPath;
      if (!existsSync2(projectPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify(fileNotFound(projectPath)) }],
          isError: true
        };
      }
      const fullPath = resolvePath2(projectPath);
      const escapedPath = fullPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `
        tell application "Xcode"
          open "${escapedPath}"
          activate
        end tell
      `;
      try {
        await execFileAsync("osascript", ["-e", script]);
        logger.info(`Opened ${fullPath} in Xcode`);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, path: fullPath }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "XCODE_OPEN_FAILED",
            message: `Failed to open project in Xcode: ${error instanceof Error ? error.message : String(error)}`,
            suggestion: "Ensure Xcode is installed. Try: open -a Xcode"
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_project_info",
    description: "Get detailed information about the Xcode project",
    inputSchema: {
      type: "object",
      properties: {
        project_path: {
          type: "string",
          description: "Path to .xcodeproj (defaults to XCODE_PROJECT_PATH)"
        }
      }
    },
    handler: async (args) => {
      const projectPath = args.project_path || config.projectPath;
      const info = getProjectInfo(projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_list_targets",
    description: "List all targets in the Xcode project",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(info.targets, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_list_schemes",
    description: "List all schemes in the Xcode project",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      return {
        content: [{ type: "text", text: JSON.stringify(info.schemes, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_list_files",
    description: "List files in the project, optionally filtered by target or file type",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Filter by target name"
        },
        file_type: {
          type: "string",
          description: "Filter by file type (swift/objc/storyboard/xcassets/plist)",
          enum: ["swift", "objc", "storyboard", "xcassets", "plist", "xib", "strings", "json", "entitlements"]
        }
      }
    },
    handler: async (args) => {
      const targetName = args.target;
      const fileType = args.file_type;
      const entries = getFileEntries(config.projectPath, targetName);
      let filtered = entries;
      if (fileType) {
        filtered = entries.filter((e) => e.type === fileType);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_add_file",
    description: "Add a file to the Xcode project",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file (relative to project root)" },
        target: { type: "string", description: "Target name to add the file to" },
        content: { type: "string", description: "File content (creates file if it does not exist)" }
      },
      required: ["file_path", "target"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const targetName = args.target;
      const content = args.content;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);
      if (!existsSync2(resolvedPath) && content) {
        const { writeFileSync, mkdirSync } = await import("fs");
        const { dirname } = await import("path");
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, content, "utf-8");
        logger.info(`Created file: ${resolvedPath}`);
      } else if (!existsSync2(resolvedPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true
        };
      }
      try {
        addFileToProject(config.projectPath, resolvedPath, targetName, content);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, file_path: filePath, target: targetName }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "ADD_FILE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Verify the target name exists and the file path is correct."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_remove_file",
    description: "Remove a file from the Xcode project",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file (relative to project root)" },
        target: { type: "string", description: "Target name to remove the file from" },
        delete_from_disk: { type: "boolean", description: "Also delete the file from disk", default: false }
      },
      required: ["file_path", "target"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const targetName = args.target;
      const deleteFromDisk = args.delete_from_disk || false;
      const resolvedPath = assertPathInProject(config.projectDir, filePath);
      try {
        removeFileFromProject(config.projectPath, resolvedPath, targetName);
        if (deleteFromDisk && existsSync2(resolvedPath)) {
          const { unlinkSync } = await import("fs");
          unlinkSync(resolvedPath);
          logger.info(`Deleted file from disk: ${resolvedPath}`);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, file_path: filePath, target: targetName, deleted_from_disk: deleteFromDisk }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "REMOVE_FILE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Verify the file exists in the project and the target name is correct."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_build_settings",
    description: "Get resolved build settings for a target and configuration",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target name" },
        configuration: { type: "string", description: "Build configuration (Debug/Release)", default: "Release" }
      },
      required: ["target"]
    },
    handler: async (args) => {
      const target = args.target;
      const configuration = args.configuration || "Release";
      try {
        const settings = await getBuildSettings(target, configuration);
        return {
          content: [{ type: "text", text: JSON.stringify(settings, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "BUILD_SETTINGS_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the target and configuration names are correct."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_set_build_setting",
    description: "Set a build setting in the Xcode project for a target and configuration",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target name" },
        configuration: { type: "string", description: "Build configuration (Debug/Release)" },
        key: { type: "string", description: "Build setting key (e.g., PRODUCT_BUNDLE_IDENTIFIER)" },
        value: { type: "string", description: "Build setting value" }
      },
      required: ["target", "configuration", "key", "value"]
    },
    handler: async (args) => {
      const target = args.target;
      const configuration = args.configuration;
      const key = args.key;
      const value = args.value;
      try {
        setBuildSetting(config.projectPath, target, configuration, key, value);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, target, configuration, key, value }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SET_SETTING_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Verify the target and configuration exist in the project."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_resolve_packages",
    description: "Resolve Swift Package Manager dependencies",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      try {
        const { resolvePackageDependencies } = await import("./xcode_runner-UHIPZEAP.js");
        const result = await resolvePackageDependencies(config.projectPath);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "RESOLVE_PACKAGES_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Check your network connection and Package.swift files."
          }) }],
          isError: true
        };
      }
    }
  });
}

// src/tools/build.ts
function registerBuildTools(server) {
  const config = server.config;
  server.registerTool({
    name: "xcode_build",
    description: "Build the Xcode project using xcodebuild",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to build (defaults to XCODE_DEFAULT_SCHEME)"
        },
        configuration: {
          type: "string",
          description: "Build configuration (Debug/Release)",
          default: "Debug"
        },
        destination: {
          type: "string",
          description: 'Build destination (e.g., "platform=iOS Simulator,name=iPhone 16")'
        },
        clean: {
          type: "boolean",
          description: "Clean build",
          default: false
        },
        derived_data_path: {
          type: "string",
          description: "Custom DerivedData path"
        }
      }
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified and XCODE_DEFAULT_SCHEME is not set",
            suggestion: "Pass a scheme argument or set XCODE_DEFAULT_SCHEME in your environment."
          }) }],
          isError: true
        };
      }
      const dest = args.destination || config.projectConfig.custom_destinations?.[0];
      try {
        const result = await runBuild({
          scheme,
          configuration: args.configuration || "Debug",
          destination: dest,
          clean: args.clean || false,
          derivedDataPath: args.derived_data_path || config.derivedDataPath,
          timeout: config.buildTimeout * 1e3,
          onProgress: (line) => {
            logger.info(`[build] ${line}`);
          }
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.success
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            ...buildFailed(error instanceof Error ? error.message : String(error)),
            scheme
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_build_for_testing",
    description: "Build the project for testing (xcodebuild build-for-testing)",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to build for testing"
        },
        destination: {
          type: "string",
          description: "Test destination"
        }
      }
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified",
            suggestion: "Pass a scheme argument."
          }) }],
          isError: true
        };
      }
      try {
        const { xcodebuild: xcodebuild2 } = await import("./xcode_runner-UHIPZEAP.js");
        const buildArgs = [
          "-scheme",
          scheme,
          "-project",
          config.projectPath,
          "-destination",
          args.destination || "platform=iOS Simulator,name=iPhone 16",
          "build-for-testing"
        ];
        const result = await xcodebuild2(buildArgs, {
          timeout: config.buildTimeout * 1e3,
          onProgress: (line) => logger.info(`[build-for-testing] ${line}`)
        });
        const parsed = parseBuildOutput(result.stdout, result.stderr);
        const success = result.stdout.includes("BUILD SUCCEEDED");
        return {
          content: [{ type: "text", text: JSON.stringify({
            success,
            scheme,
            errors: parsed.errors,
            warnings: parsed.warnings,
            output: result.stdout.slice(-2e3)
          }, null, 2) }],
          isError: !success
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_archive",
    description: "Build an archive of the project for distribution",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to archive"
        },
        export_options: {
          type: "object",
          description: "Export options (method, teamID, etc.)",
          properties: {
            method: { type: "string", description: "Export method (app-store/ad-hoc/development/enterprise)" },
            teamID: { type: "string", description: "Team ID for signing" },
            signingStyle: { type: "string", description: "automatic/manual" }
          }
        }
      }
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified",
            suggestion: "Pass a scheme argument."
          }) }],
          isError: true
        };
      }
      try {
        const exportOptions = args.export_options;
        const result = await archiveBuild(scheme, config.projectPath, exportOptions);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.success
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_clean",
    description: "Clean the Xcode build directory",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to clean (optional)"
        },
        derived_data: {
          type: "boolean",
          description: "Also wipe DerivedData",
          default: false
        }
      }
    },
    handler: async (args) => {
      const results = [];
      try {
        const { xcodebuild: xcodebuild2 } = await import("./xcode_runner-UHIPZEAP.js");
        const cleanArgs = ["clean"];
        const scheme = args.scheme || config.defaultScheme;
        if (scheme) cleanArgs.push("-scheme", scheme);
        cleanArgs.push("-project", config.projectPath);
        const result = await xcodebuild2(cleanArgs, { timeout: 12e4 });
        results.push(result.stdout.includes("CLEAN SUCCEEDED") ? "Clean succeeded" : "Clean may have had issues");
        if (args.derived_data) {
          const { execSync } = await import("child_process");
          execSync("rm -rf ~/Library/Developer/Xcode/DerivedData/*", { stdio: "pipe" });
          results.push("DerivedData wiped");
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, results }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_build_errors",
    description: "Get parsed errors and warnings from the most recent build",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      const { readdirSync: readdirSync5, readFileSync: readFileSync3, statSync: statSync4 } = await import("fs");
      const { join: join6 } = await import("path");
      const { homedir: homedir4 } = await import("os");
      const derivedData = join6(homedir4(), "Library", "Developer", "Xcode", "DerivedData");
      try {
        const dirs = readdirSync5(derivedData);
        const projectName = config.projectPath.split("/").pop()?.replace(/\.xcodeproj$/, "") || "";
        const matchingDir = dirs.find((d) => d.startsWith(projectName));
        if (!matchingDir) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              errors: [],
              warnings: [],
              message: "No DerivedData found for this project. Build the project first."
            }, null, 2) }]
          };
        }
        const buildLogDir = join6(derivedData, matchingDir, "Logs", "Build");
        const logFiles = readdirSync5(buildLogDir).filter((f) => f.endsWith(".xcactivitylog")).map((f) => ({ name: f, time: statSync4(join6(buildLogDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
        if (logFiles.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ errors: [], warnings: [], message: "No build logs found." }) }]
          };
        }
        const latestLog = readFileSync3(join6(buildLogDir, logFiles[0].name), "utf-8");
        const parsed = parseBuildOutput(latestLog, "");
        return {
          content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            errors: [],
            warnings: [],
            message: `Could not read build logs: ${error instanceof Error ? error.message : String(error)}`
          }, null, 2) }]
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_analyzer_results",
    description: "Run the static analyzer and return issues",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to analyze"
        },
        target: {
          type: "string",
          description: "Optional target to analyze"
        }
      }
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified",
            suggestion: "Pass a scheme argument."
          }) }],
          isError: true
        };
      }
      try {
        const result = await runAnalyze(scheme, args.target);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(buildFailed(error instanceof Error ? error.message : String(error))) }],
          isError: true
        };
      }
    }
  });
}

// src/tools/simulator.ts
function registerSimulatorTools(server) {
  server.registerTool({
    name: "xcode_list_simulators",
    description: "List all available simulators grouped by OS",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      const simulators = await getAvailableSimulators();
      return {
        content: [{ type: "text", text: JSON.stringify(simulators, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_boot_simulator",
    description: "Boot a simulator by UDID",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID or name" }
      },
      required: ["udid"]
    },
    handler: async (args) => {
      const query = args.udid;
      let udid = query;
      if (query.length < 36) {
        const device = await findSimulator(query);
        if (!device) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: "SIMULATOR_NOT_FOUND",
              message: `No simulator found matching: ${query}`,
              suggestion: "Use xcode_list_simulators to see available simulators."
            }) }],
            isError: true
          };
        }
        udid = device.udid;
      }
      try {
        const result = await bootSimulator(udid);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, udid: result }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SIMULATOR_BOOT_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Try erasing the simulator first: xcrun simctl erase udid"
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_shutdown_simulator",
    description: "Shutdown a simulator by UDID",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" }
      },
      required: ["udid"]
    },
    handler: async (args) => {
      const udid = args.udid;
      try {
        await shutdownSimulator(udid);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, udid }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SIMULATOR_SHUTDOWN_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Try forcing shutdown: xcrun simctl shutdown udid"
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_install_app",
    description: "Install an app on a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        app_path: { type: "string", description: "Path to .app bundle" }
      },
      required: ["udid", "app_path"]
    },
    handler: async (args) => {
      try {
        await installApp(args.udid, args.app_path);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "INSTALL_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the app path is correct and the simulator is booted."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_launch_app",
    description: "Launch an app on a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        bundle_id: { type: "string", description: "Bundle identifier to launch" },
        arguments: { type: "array", items: { type: "string" }, description: "Launch arguments" },
        environment: { type: "object", description: "Environment variables" }
      },
      required: ["udid", "bundle_id"]
    },
    handler: async (args) => {
      try {
        const pid = await launchApp(
          args.udid,
          args.bundle_id,
          args.arguments,
          args.environment
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, pid }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "LAUNCH_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the app is installed and the simulator is booted."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_terminate_app",
    description: "Terminate a running app on a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        bundle_id: { type: "string", description: "Bundle identifier to terminate" }
      },
      required: ["udid", "bundle_id"]
    },
    handler: async (args) => {
      try {
        await terminateApp(args.udid, args.bundle_id);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "TERMINATE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "The app may not be running. Check with xcrun simctl list."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_simulator_logs",
    description: "Get logs from a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        bundle_id: { type: "string", description: "Filter by bundle identifier" },
        lines: { type: "number", description: "Number of lines to fetch", default: 100 },
        filter: { type: "string", description: "Log predicate filter string" }
      },
      required: ["udid"]
    },
    handler: async (args) => {
      try {
        const logs = await getSimulatorLogs(args.udid, {
          bundleId: args.bundle_id,
          lines: args.lines || 100,
          filter: args.filter
        });
        return {
          content: [{ type: "text", text: JSON.stringify(logs, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "LOG_FETCH_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator UDID is correct and the simulator exists."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_screenshot_simulator",
    description: "Take a screenshot of a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        output_path: { type: "string", description: "Output path for PNG (optional, uses temp dir)" }
      },
      required: ["udid"]
    },
    handler: async (args) => {
      try {
        const path = await screenshotSimulator(args.udid, args.output_path);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, path }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SCREENSHOT_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator is booted."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_record_simulator",
    description: "Record video of a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        output_path: { type: "string", description: "Output path for .mp4" },
        duration_seconds: { type: "number", description: "Recording duration in seconds", default: 10 }
      },
      required: ["udid", "output_path"]
    },
    handler: async (args) => {
      try {
        const path = await recordSimulator(
          args.udid,
          args.output_path,
          args.duration_seconds || 10
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, path }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "RECORD_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator is booted and the output path is writable."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_open_url_simulator",
    description: "Open a URL on a simulator (for deep link testing)",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        url: { type: "string", description: "URL to open (e.g., myapp://deep-link)" }
      },
      required: ["udid", "url"]
    },
    handler: async (args) => {
      try {
        await openURL(args.udid, args.url);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "OPEN_URL_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator is booted and the URL scheme is registered."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_set_simulator_location",
    description: "Set the simulated location for a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        latitude: { type: "number", description: "Latitude" },
        longitude: { type: "number", description: "Longitude" }
      },
      required: ["udid", "latitude", "longitude"]
    },
    handler: async (args) => {
      try {
        await setSimulatorLocation(args.udid, args.latitude, args.longitude);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "LOCATION_SET_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator is booted."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_push_notification_simulator",
    description: "Simulate a push notification on a simulator",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" },
        bundle_id: { type: "string", description: "Target app bundle identifier" },
        payload: { type: "object", description: "Push notification payload (JSON)" }
      },
      required: ["udid", "bundle_id", "payload"]
    },
    handler: async (args) => {
      try {
        await pushNotification(args.udid, args.bundle_id, args.payload);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "PUSH_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator is booted and the app is installed."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_reset_simulator",
    description: "Reset a simulator to factory state (erase content and settings)",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Simulator UDID" }
      },
      required: ["udid"]
    },
    handler: async (args) => {
      try {
        await resetSimulator(args.udid);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, udid: args.udid }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "RESET_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the simulator exists."
          }) }],
          isError: true
        };
      }
    }
  });
}

// src/tools/testing.ts
import { existsSync as existsSync3 } from "fs";
function parseTestResults(stdout, stderr) {
  const failures = [];
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationSeconds = 0;
  const output = stdout + "\n" + stderr;
  const testRunMatch = output.match(/Test\s+run\s+(?:succeeded|failed)\s+with\s+(\d+)\s+tests?/);
  if (testRunMatch && testRunMatch[1]) {
    totalTests = parseInt(testRunMatch[1], 10);
  }
  const passedMatch = output.match(/(\d+)\s+tests?\s+passed/);
  if (passedMatch && passedMatch[1]) {
    passed = parseInt(passedMatch[1], 10);
  }
  const failedMatch = output.match(/(\d+)\s+tests?\s+failed/);
  if (failedMatch && failedMatch[1]) {
    failed = parseInt(failedMatch[1], 10);
  }
  const skippedMatch = output.match(/(\d+)\s+tests?\s+skipped/);
  if (skippedMatch && skippedMatch[1]) {
    skipped = parseInt(skippedMatch[1], 10);
  }
  const durationMatch = output.match(/(?:Executed|\s+)(\d+)\s+tests?.*?\(([\d.]+)\s+seconds\)/);
  if (durationMatch && durationMatch[2]) {
    durationSeconds = parseFloat(durationMatch[2]);
  }
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || "";
    const failMatch = line.match(/^\s*(-\[(\w+(?:\s+\w+)?)\s+(\w+)\])|(?:FAIL|error:)\s*(?:-\[(\w+(?:\s+\w+)?)\s+(\w+)\])/);
    if (failMatch) {
      const testName = failMatch[1] || `-${failMatch[4]} ${failMatch[5]}`;
      const nextLine = lines[i + 1] || "";
      const fileMatch = nextLine.match(/(.+?):(\d+):\s*(.+)/);
      failures.push({
        testName: testName.replace(/^-\s*\[|\]$/g, "").trim(),
        className: failMatch[2] || failMatch[4] || "",
        file: fileMatch?.[1],
        line: fileMatch?.[2] ? parseInt(fileMatch[2], 10) : void 0,
        message: fileMatch?.[3] || nextLine
      });
    }
    const modernFailMatch = line.match(/(\w[\w\/]+)\s*:\s*(?:error|FAIL).*?at\s+(.+?):(\d+)/);
    if (modernFailMatch) {
      failures.push({
        testName: modernFailMatch[1],
        className: modernFailMatch[1].split("/")[0] || "",
        file: modernFailMatch[2],
        line: parseInt(modernFailMatch[3], 10),
        message: line
      });
    }
  }
  if (totalTests === 0 && passed === 0) {
    for (const line of lines) {
      const testMatch = line.match(/Test\s+case\s+'(?:-\[(\w+)\s+(\w+)\]|(\w+)\.(\w+))'\s+(?:passed|failed)/);
      if (testMatch) {
        totalTests++;
        if (line.includes("passed")) passed++;
        else if (line.includes("failed")) failed++;
      }
    }
  }
  return {
    totalTests: totalTests || passed + failed + skipped,
    passed,
    failed,
    skipped,
    durationSeconds,
    failures,
    outputLog: output.slice(-1e4)
  };
}
function registerTestingTools(server) {
  const config = server.config;
  server.registerTool({
    name: "xcode_run_tests",
    description: "Run tests using xcodebuild",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to test"
        },
        destination: {
          type: "string",
          description: 'Test destination (e.g., "platform=iOS Simulator,name=iPhone 16")'
        },
        test_plan: {
          type: "string",
          description: "Test plan name"
        },
        test_filter: {
          type: "string",
          description: 'Test filter (e.g., "TargetName/ClassName/testMethodName")'
        },
        parallel: {
          type: "boolean",
          description: "Run tests in parallel",
          default: false
        },
        result_bundle_path: {
          type: "string",
          description: "Custom path for xcresult bundle"
        }
      }
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified and XCODE_DEFAULT_SCHEME is not set",
            suggestion: "Pass a scheme argument or set XCODE_DEFAULT_SCHEME."
          }) }],
          isError: true
        };
      }
      const buildArgs = [
        "-scheme",
        scheme,
        "-project",
        config.projectPath,
        "-destination",
        args.destination || "platform=iOS Simulator,name=iPhone 16",
        "test"
      ];
      if (args.test_plan) {
        buildArgs.push("-testPlan", args.test_plan);
      }
      if (args.test_filter) {
        buildArgs.push("-only-testing", args.test_filter);
      }
      if (args.parallel) {
        buildArgs.push("-parallel-testing-enabled", "YES");
      } else {
        buildArgs.push("-parallel-testing-enabled", "NO");
      }
      if (args.result_bundle_path) {
        buildArgs.push("-resultBundlePath", args.result_bundle_path);
      }
      try {
        const startTime = Date.now();
        const result = await xcodebuild(buildArgs, {
          timeout: config.testTimeout * 1e3,
          onProgress: (line) => logger.info(`[test] ${line}`)
        });
        const duration = (Date.now() - startTime) / 1e3;
        const testResults = parseTestResults(result.stdout, result.stderr);
        testResults.durationSeconds = duration;
        const success = !testResults.failed || testResults.failed === 0;
        return {
          content: [{ type: "text", text: JSON.stringify(testResults, null, 2) }],
          isError: !success
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(testFailure(error instanceof Error ? error.message : String(error))) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_test_results",
    description: "Get parsed test results from an xcresult bundle",
    inputSchema: {
      type: "object",
      properties: {
        result_bundle_path: {
          type: "string",
          description: "Path to .xcresult bundle (defaults to latest)"
        }
      }
    },
    handler: async (args) => {
      try {
        const resultPath = args.result_bundle_path;
        let xcresultPath = resultPath;
        if (!xcresultPath) {
          const { readdirSync: readdirSync5, statSync: statSync4 } = await import("fs");
          const { join: join6 } = await import("path");
          const { homedir: homedir4 } = await import("os");
          const derivedData = join6(homedir4(), "Library", "Developer", "Xcode", "DerivedData");
          const dirs = readdirSync5(derivedData);
          const projectName = config.projectPath.split("/").pop()?.replace(/\.xcodeproj$/, "") || "";
          const matchingDir = dirs.find((d) => d.startsWith(projectName));
          if (matchingDir) {
            const testLogsDir = join6(derivedData, matchingDir, "Logs", "Test");
            if (existsSync3(testLogsDir)) {
              const results = readdirSync5(testLogsDir).filter((f) => f.endsWith(".xcresult")).map((f) => ({ name: f, time: statSync4(join6(testLogsDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
              if (results.length > 0 && results[0]) {
                xcresultPath = join6(testLogsDir, results[0].name);
              }
            }
          }
        }
        if (!xcresultPath || !existsSync3(xcresultPath)) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              message: "No xcresult bundle found. Run tests first."
            }) }]
          };
        }
        const { xcrun: xcrun2 } = await import("./xcode_runner-UHIPZEAP.js");
        const result = await xcrun2("xcresulttool", ["get", "--format", "json", "--path", xcresultPath]);
        const parsed = JSON.parse(result.stdout);
        return {
          content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "TEST_RESULTS_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure tests have been run and the xcresult path is valid."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_get_code_coverage",
    description: "Get code coverage report from latest test run",
    inputSchema: {
      type: "object",
      properties: {
        result_bundle_path: {
          type: "string",
          description: "Path to .xcresult bundle"
        }
      }
    },
    handler: async (args) => {
      try {
        const { xcrun: xcrun2 } = await import("./xcode_runner-UHIPZEAP.js");
        const resultPath = args.result_bundle_path;
        if (resultPath && existsSync3(resultPath)) {
          const report = await xcrun2("xccov", ["view", "--report", "--path", resultPath]);
          const jsonReport = await xcrun2("xccov", ["view", "--report", "--json", "--path", resultPath]);
          const coverageData = JSON.parse(jsonReport.stdout);
          return {
            content: [{ type: "text", text: JSON.stringify({
              summary: report.stdout.slice(0, 2e3),
              data: coverageData
            }, null, 2) }]
          };
        }
        const { homedir: homedir4 } = await import("os");
        const { join: join6 } = await import("path");
        const { readdirSync: readdirSync5, statSync: statSync4 } = await import("fs");
        const derivedData = join6(homedir4(), "Library", "Developer", "Xcode", "DerivedData");
        const dirs = readdirSync5(derivedData);
        const projectName = config.projectPath.split("/").pop()?.replace(/\.xcodeproj$/, "") || "";
        const matchingDir = dirs.find((d) => d.startsWith(projectName));
        if (matchingDir) {
          const testLogsDir = join6(derivedData, matchingDir, "Logs", "Test");
          if (existsSync3(testLogsDir)) {
            const results = readdirSync5(testLogsDir).filter((f) => f.endsWith(".xcresult")).map((f) => ({ name: f, time: statSync4(join6(testLogsDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
            if (results.length > 0 && results[0]) {
              const latestPath = join6(testLogsDir, results[0].name);
              const report = await xcrun2("xccov", ["view", "--report", "--path", latestPath]);
              return {
                content: [{ type: "text", text: JSON.stringify({ report: report.stdout }) }]
              };
            }
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ message: "No coverage data found. Run tests with code coverage enabled." }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "COVERAGE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure code coverage is enabled in your scheme and tests have been run."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_run_single_test",
    description: "Run a single test method",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to test"
        },
        destination: {
          type: "string",
          description: "Test destination"
        },
        test_identifier: {
          type: "string",
          description: 'Test identifier (e.g., "TargetName/ClassName/testMethodName")'
        }
      },
      required: ["test_identifier"]
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified",
            suggestion: "Pass a scheme argument."
          }) }],
          isError: true
        };
      }
      const buildArgs = [
        "-scheme",
        scheme,
        "-project",
        config.projectPath,
        "-destination",
        args.destination || "platform=iOS Simulator,name=iPhone 16",
        "test",
        "-only-testing",
        args.test_identifier
      ];
      try {
        const result = await xcodebuild(buildArgs, {
          timeout: config.testTimeout * 1e3,
          onProgress: (line) => logger.info(`[test] ${line}`)
        });
        const testResults = parseTestResults(result.stdout, result.stderr);
        return {
          content: [{ type: "text", text: JSON.stringify(testResults, null, 2) }],
          isError: testResults.failed > 0
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify(testFailure(error instanceof Error ? error.message : String(error))) }],
          isError: true
        };
      }
    }
  });
}

// src/tools/code.ts
import { existsSync as existsSync4 } from "fs";
import { readFile as readFile2, writeFile, stat } from "fs/promises";
import { resolve as resolvePath3 } from "path";
function assertPathInProject2(projectDir, filePath) {
  const resolved = resolvePath3(projectDir, filePath);
  if (!resolved.startsWith(projectDir)) {
    throw pathTraversalDetected(filePath);
  }
  return resolved;
}
function registerCodeTools(server) {
  const config = server.config;
  server.registerTool({
    name: "xcode_read_file",
    description: "Read a Swift/ObjC file from the project",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root"
        }
      },
      required: ["file_path"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const resolvedPath = assertPathInProject2(config.projectDir, filePath);
      if (!existsSync4(resolvedPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true
        };
      }
      const content = await readFile2(resolvedPath, "utf-8");
      const fileStat = await stat(resolvedPath);
      const lines = content.split("\n");
      return {
        content: [{ type: "text", text: JSON.stringify({
          file_path: filePath,
          content,
          line_count: lines.length,
          file_size: fileStat.size,
          last_modified: fileStat.mtime.toISOString()
        }, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_write_file",
    description: "Write content to a Swift/ObjC file in the project",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root"
        },
        content: {
          type: "string",
          description: "File content"
        },
        create_if_missing: {
          type: "boolean",
          description: "Create file if it does not exist and add to project",
          default: true
        }
      },
      required: ["file_path", "content"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const content = args.content;
      const createIfMissing = args.create_if_missing !== false;
      const resolvedPath = assertPathInProject2(config.projectDir, filePath);
      const fileExists = existsSync4(resolvedPath);
      if (!fileExists && !createIfMissing) {
        return {
          content: [{ type: "text", text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true
        };
      }
      const { mkdirSync } = await import("fs");
      const { dirname } = await import("path");
      mkdirSync(dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, content, "utf-8");
      logger.info(`Wrote file: ${resolvedPath}`);
      if (!fileExists && createIfMissing) {
        try {
          const { getProjectInfo: getProjectInfo2 } = await import("./pbxproj_parser-VGMEPZVV.js");
          const { addFileToProject: addFileToProject2 } = await import("./pbxproj_writer-BBRZG2DX.js");
          const info = getProjectInfo2(config.projectPath);
          const target = info.targets[0];
          if (target) {
            addFileToProject2(config.projectPath, filePath, target.name, content);
          }
        } catch (err) {
          logger.warn(`Could not auto-add file to project: ${err}`);
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true,
          file_path: filePath,
          created: !fileExists
        }) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_edit_file",
    description: "Find and replace content in a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root"
        },
        old_content: {
          type: "string",
          description: "Exact text to find"
        },
        new_content: {
          type: "string",
          description: "Replacement text"
        }
      },
      required: ["file_path", "old_content", "new_content"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const oldContent = args.old_content;
      const newContent = args.new_content;
      const resolvedPath = assertPathInProject2(config.projectDir, filePath);
      if (!existsSync4(resolvedPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true
        };
      }
      let content = await readFile2(resolvedPath, "utf-8");
      const occurrences = content.split(oldContent).length - 1;
      if (occurrences === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "CONTENT_NOT_FOUND",
            message: `Could not find the specified text in ${filePath}`,
            suggestion: "Check the exact content to match, including whitespace."
          }) }],
          isError: true
        };
      }
      if (occurrences >= 2) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "MULTIPLE_MATCHES",
            message: `Found ${occurrences} matches in ${filePath}. Provide more context for a unique match.`
          }) }],
          isError: true
        };
      }
      content = content.replace(oldContent, newContent);
      await writeFile(resolvedPath, content, "utf-8");
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true,
          file_path: filePath,
          replacements: 1
        }) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_get_swift_symbols",
    description: "Extract Swift symbols (classes, structs, enums, protocols, functions, properties)",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path relative to project root"
        }
      },
      required: ["file_path"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const resolvedPath = assertPathInProject2(config.projectDir, filePath);
      if (!existsSync4(resolvedPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify(fileNotFound(filePath)) }],
          isError: true
        };
      }
      const content = await readFile2(resolvedPath, "utf-8");
      const lines = content.split("\n");
      const symbols = [];
      const patterns = [
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(class)\s+(\w+)/, kind: "class" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(struct)\s+(\w+)/, kind: "struct" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(enum)\s+(\w+)/, kind: "enum" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(protocol)\s+(\w+)/, kind: "protocol" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(extension)\s+(\w+)/, kind: "extension" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*func\s+(\w+)/, kind: "function" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*var\s+(\w+)/, kind: "property" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*let\s+(\w+)/, kind: "constant" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*typealias\s+(\w+)/, kind: "typealias" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*associatedtype\s+(\w+)/, kind: "associatedtype" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*actor\s+(\w+)/, kind: "actor" },
        { regex: /\b(public|private|fileprivate|internal|open)?\s*(case)\s+(\w+)/, kind: "enum_case" }
      ];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
        for (const { regex, kind } of patterns) {
          const match = trimmed.match(regex);
          if (match) {
            const accessLevel = match[1] || void 0;
            const name = match[match.length - 1];
            if (name && !name.startsWith("//")) {
              symbols.push({
                kind,
                name,
                line: i + 1,
                accessLevel: accessLevel !== "open" ? accessLevel : void 0
              });
            }
            break;
          }
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(symbols, null, 2) }]
      };
    }
  });
  server.registerTool({
    name: "xcode_format_file",
    description: "Format a Swift file using swift-format",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path or directory to format (relative to project root)"
        }
      },
      required: ["file_path"]
    },
    handler: async (args) => {
      const filePath = args.file_path;
      const resolvedPath = assertPathInProject2(config.projectDir, filePath);
      try {
        const { execFile: execFile3 } = await import("child_process");
        const { promisify: promisify3 } = await import("util");
        const execFileAsync3 = promisify3(execFile3);
        await execFileAsync3("which", ["swift-format"]);
        await execFileAsync3("swift-format", ["--in-place", resolvedPath]);
        const diffResult = await execFileAsync3("swift-format", ["--diagnostics", resolvedPath]);
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            file_path: filePath,
            diagnostics: diffResult.stdout
          }, null, 2) }]
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes("swift-format")) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: "SWIFT_FORMAT_NOT_FOUND",
              message: "swift-format is not installed",
              suggestion: "Install via: brew install swift-format\nOr: mint install swift-format"
            }) }],
            isError: true
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "FORMAT_FAILED",
            message: errMsg,
            suggestion: "Check that the file exists and swift-format is installed."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_search_in_project",
    description: "Search for text across all project files",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query"
        },
        file_type: {
          type: "string",
          description: "Filter by file extension (e.g., swift, objc)"
        },
        case_sensitive: {
          type: "boolean",
          description: "Case sensitive search",
          default: false
        },
        regex: {
          type: "boolean",
          description: "Use regex for search",
          default: false
        }
      },
      required: ["query"]
    },
    handler: async (args) => {
      const query = args.query;
      const fileType = args.file_type;
      const caseSensitive = args.case_sensitive || false;
      const useRegex = args.regex || false;
      const { execFile: execFile3 } = await import("child_process");
      const { promisify: promisify3 } = await import("util");
      const execFileAsync3 = promisify3(execFile3);
      const grepArgs = ["-rn"];
      if (!caseSensitive) {
        grepArgs.push("-i");
      }
      if (useRegex) {
        grepArgs.push("-E");
      }
      if (fileType && fileType !== "other") {
        const extMap = {
          swift: "*.swift",
          objc: "*.{m,mm,h}",
          storyboard: "*.storyboard",
          xib: "*.xib",
          plist: "*.plist",
          json: "*.json"
        };
        grepArgs.push("--include", extMap[fileType] || `*.${fileType}`);
      } else {
        grepArgs.push("--include", "*.swift", "--include", "*.m", "--include", "*.mm", "--include", "*.h");
      }
      grepArgs.push(query, config.projectDir);
      try {
        const result = await execFileAsync3("grep", grepArgs, { timeout: 3e4 });
        const lines = result.stdout.split("\n").filter(Boolean);
        const matches = lines.map((line) => {
          const parts = line.split(":");
          return {
            file_path: parts[0] || "",
            line_number: parseInt(parts[1] || "0", 10),
            line_content: parts.slice(2).join(":")
          };
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ matches, total: matches.length }, null, 2) }]
        };
      } catch (error) {
        const err = error;
        if (String(err.code) === "1") {
          return {
            content: [{ type: "text", text: JSON.stringify({ matches: [], total: 0 }) }]
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SEARCH_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Check the query syntax and try again."
          }) }],
          isError: true
        };
      }
    }
  });
}

// src/tools/signing.ts
import { readdirSync } from "fs";
import { join as join2 } from "path";
import { homedir } from "os";
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
var execFileAsync2 = promisify2(execFile2);
function registerSigningTools(server) {
  server.registerTool({
    name: "xcode_list_certificates",
    description: "List all valid code signing certificates",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      try {
        const result = await execFileAsync2("security", ["find-identity", "-v", "-p", "codesigning"]);
        const lines = result.stdout.split("\n").filter(Boolean);
        const certificates = lines.map((line) => {
          const match = line.match(/^\s+\d+\)\s+([A-F0-9]+)\s+"(.+?)"/);
          if (match && match[1] && match[2]) {
            return {
              sha1: match[1],
              name: match[2]
            };
          }
          return null;
        }).filter(Boolean);
        return {
          content: [{ type: "text", text: JSON.stringify(certificates, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "CERTIFICATE_LIST_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure Xcode is installed and you have valid signing certificates."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_list_provisioning_profiles",
    description: "List all provisioning profiles",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      try {
        const profilesDir = join2(homedir(), "Library", "MobileDevice", "Provisioning Profiles");
        const files = readdirSync(profilesDir).filter((f) => f.endsWith(".mobileprovision"));
        const profiles = [];
        for (const file of files) {
          const filePath = join2(profilesDir, file);
          const result = await execFileAsync2("security", ["cms", "-D", "-i", filePath]);
          const content = result.stdout;
          const nameMatch = content.match(/<key>Name<\/key>\s*<string>(.+?)<\/string>/);
          const bundleIdMatch = content.match(/<key>application-identifier<\/key>\s*<string>(.+?)<\/string>/);
          const teamMatch = content.match(/<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>(.+?)<\/string>/);
          const expiryMatch = content.match(/<key>ExpirationDate<\/key>\s*<date>(.+?)<\/date>/);
          const devCountMatch = content.match(/<key>ProvisionedDevices<\/key>\s*<array>\s*<string>(.+?)<\/string>/s);
          profiles.push({
            file,
            name: nameMatch?.[1] || "Unknown",
            bundle_id: bundleIdMatch?.[1] ? bundleIdMatch[1].replace(/^[A-Z0-9]+\./, "") : "Unknown",
            team_id: teamMatch?.[1] || "Unknown",
            expiry: expiryMatch?.[1] || "Unknown",
            device_count: devCountMatch ? content.split("ProvisionedDevices")[1]?.split("<string>").length - 1 : 0
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(profiles, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "PROFILE_LIST_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure you have provisioning profiles installed."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_set_signing",
    description: "Set code signing settings for a target",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target name" },
        team_id: { type: "string", description: "Team ID" },
        bundle_id: { type: "string", description: "Bundle identifier" },
        profile_name: { type: "string", description: "Provisioning profile name" },
        automatic: { type: "boolean", description: "Use automatic signing", default: true }
      },
      required: ["target", "team_id", "bundle_id"]
    },
    handler: async (args) => {
      const target = args.target;
      const teamId = args.team_id;
      const bundleId = args.bundle_id;
      const automatic = args.automatic !== false;
      try {
        for (const cfg of ["Debug", "Release"]) {
          const projectPath = server.config.projectPath;
          setBuildSetting(projectPath, target, cfg, "DEVELOPMENT_TEAM", teamId);
          setBuildSetting(projectPath, target, cfg, "PRODUCT_BUNDLE_IDENTIFIER", bundleId);
          if (automatic) {
            setBuildSetting(projectPath, target, cfg, "CODE_SIGN_STYLE", "Automatic");
          } else {
            setBuildSetting(projectPath, target, cfg, "CODE_SIGN_STYLE", "Manual");
            if (args.profile_name) {
              setBuildSetting(projectPath, target, cfg, "PROVISIONING_PROFILE_SPECIFIER", args.profile_name);
            }
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            target,
            team_id: teamId,
            bundle_id: bundleId,
            automatic
          }) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SIGNING_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Verify the target name and team ID are correct."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_validate_signing",
    description: "Validate code signing of an app bundle",
    inputSchema: {
      type: "object",
      properties: {
        app_path: { type: "string", description: "Path to .app bundle" }
      },
      required: ["app_path"]
    },
    handler: async (args) => {
      const appPath = args.app_path;
      try {
        const result = await execFileAsync2("codesign", ["--verify", "--verbose", appPath]);
        return {
          content: [{ type: "text", text: JSON.stringify({
            valid: true,
            message: "Code signature is valid",
            details: result.stderr || result.stdout
          }, null, 2) }]
        };
      } catch (error) {
        const err = error;
        return {
          content: [{ type: "text", text: JSON.stringify({
            valid: false,
            message: "Code signature validation failed",
            details: err.stderr || err.stdout || err.message || String(error)
          }, null, 2) }],
          isError: false
        };
      }
    }
  });
}

// src/tools/diagnostics.ts
import { existsSync as existsSync5, readFileSync, readdirSync as readdirSync2, statSync } from "fs";
import { join as join3 } from "path";
import { homedir as homedir2 } from "os";
function registerDiagnosticsTools(server) {
  const config = server.config;
  server.registerTool({
    name: "xcode_get_warnings",
    description: "Get all warnings from the latest build",
    inputSchema: {
      type: "object",
      properties: {}
    },
    handler: async () => {
      try {
        const derivedData = join3(homedir2(), "Library", "Developer", "Xcode", "DerivedData");
        const dirs = readdirSync2(derivedData);
        const projectName = config.projectPath.split("/").pop()?.replace(/\.xcodeproj$/, "") || "";
        const matchingDir = dirs.find((d) => d.startsWith(projectName));
        if (!matchingDir) {
          return {
            content: [{ type: "text", text: JSON.stringify({ warnings: [], message: "No build logs found. Build the project first." }) }]
          };
        }
        const buildLogDir = join3(derivedData, matchingDir, "Logs", "Build");
        if (!existsSync5(buildLogDir)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ warnings: [], message: "No build logs found. Build the project first." }) }]
          };
        }
        const logFiles = readdirSync2(buildLogDir).filter((f) => f.endsWith(".xcactivitylog")).map((f) => ({ name: f, time: statSync(join3(buildLogDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
        if (logFiles.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ warnings: [], message: "No build logs found." }) }]
          };
        }
        const latestLog = readFileSync(join3(buildLogDir, logFiles[0].name), "utf-8");
        const parsed = parseBuildOutput(latestLog, "");
        const groupedWarnings = {};
        for (const w of parsed.warnings) {
          const file = w.file || "(unknown)";
          if (!groupedWarnings[file]) groupedWarnings[file] = [];
          groupedWarnings[file].push(w);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            warning_count: parsed.warnings.length,
            error_count: parsed.errors.length,
            warnings_by_file: groupedWarnings,
            all_warnings: parsed.warnings
          }, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "WARNINGS_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Build the project first to generate warnings."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_profile_app",
    description: "Profile an app using xctrace (Instruments)",
    inputSchema: {
      type: "object",
      properties: {
        scheme: {
          type: "string",
          description: "Scheme to profile"
        },
        destination: {
          type: "string",
          description: "Destination (e.g., platform=iOS Simulator,name=iPhone 16)"
        },
        template: {
          type: "string",
          description: 'Instruments template (e.g., "Time Profiler", "Leaks", "Allocations")',
          default: "Time Profiler"
        },
        duration_seconds: {
          type: "number",
          description: "Recording duration in seconds",
          default: 10
        }
      }
    },
    handler: async (args) => {
      const scheme = args.scheme || config.defaultScheme;
      if (!scheme) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "NO_SCHEME",
            message: "No scheme specified",
            suggestion: "Pass a scheme argument."
          }) }],
          isError: true
        };
      }
      try {
        const tmpDir = join3(homedir2(), "tmp");
        const tracePath = join3(tmpDir, `${scheme}-${Date.now()}.trace`);
        await xcrun("xctrace", [
          "record",
          "--template",
          args.template || "Time Profiler",
          "--device",
          args.destination || "",
          "--time-limit",
          `${args.duration_seconds || 10}s`,
          "--output",
          tracePath,
          "--target",
          scheme
        ]);
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            output_path: tracePath,
            schema: scheme,
            template: args.template || "Time Profiler"
          }, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "PROFILE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the scheme builds successfully and a simulator is booted."
          }) }],
          isError: true
        };
      }
    }
  });
  server.registerTool({
    name: "xcode_add_spm_package",
    description: "Add a Swift Package Manager dependency to the project",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Package repository URL (e.g., https://github.com/pointfreeco/swift-composable-architecture)"
        },
        version_requirement: {
          type: "object",
          description: "Version requirement (exact version, range, or branch)",
          properties: {
            type: {
              type: "string",
              description: "Requirement type: exact, upToNextMajorVersion, upToNextMinorVersion, branch, revision",
              enum: ["exact", "upToNextMajorVersion", "upToNextMinorVersion", "branch", "revision"]
            },
            value: {
              type: "string",
              description: 'Version or branch name (e.g., "1.0.0", "main")'
            }
          }
        },
        target: {
          type: "string",
          description: "Target to link the package to"
        }
      },
      required: ["url", "target"]
    },
    handler: async (args) => {
      const url = args.url;
      const targetName = args.target;
      const versionReq = args.version_requirement;
      const versionType = versionReq?.type || "upToNextMajorVersion";
      const versionValue = versionReq?.value || "1.0.0";
      try {
        const packageName = url.split("/").pop()?.replace(/\.git$/, "") || "Package";
        const { resolvePackageDependencies } = await import("./xcode_runner-UHIPZEAP.js");
        const result = await resolvePackageDependencies(config.projectPath);
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            package_name: packageName,
            url,
            version: `${versionType}: ${versionValue}`,
            target: targetName,
            resolved: result,
            note: "Package reference added. You may need to add the product to your target in Xcode."
          }, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "SPM_ADD_FAILED",
            message: error instanceof Error ? error.message : String(error),
            suggestion: "Ensure the package URL is valid and the project is configured correctly."
          }) }],
          isError: true
        };
      }
    }
  });
}

// src/resources/project_structure.ts
import { readdirSync as readdirSync3, statSync as statSync2 } from "fs";
import { join as join4, relative } from "path";
function buildFileTree(dirPath, projectDir, excludedPaths = []) {
  const entries = [];
  try {
    const items = readdirSync3(dirPath);
    for (const item of items) {
      const fullPath = join4(dirPath, item);
      const relPath = relative(projectDir, fullPath);
      if (excludedPaths.some((p) => relPath.startsWith(p))) continue;
      if (item.startsWith(".") || item === "DerivedData" || item === "build") continue;
      try {
        const stat2 = statSync2(fullPath);
        if (stat2.isDirectory()) {
          const children = buildFileTree(fullPath, projectDir, excludedPaths);
          entries.push({
            name: item,
            type: "directory",
            path: relPath,
            children
          });
        } else {
          const ext = item.split(".").pop()?.toLowerCase() || "";
          const typeMap = {
            swift: "swift",
            m: "objc",
            mm: "objc",
            h: "objc-header",
            storyboard: "storyboard",
            xib: "xib",
            xcassets: "xcassets",
            plist: "plist",
            strings: "strings",
            json: "json",
            entitlements: "entitlements",
            png: "image",
            jpg: "image",
            jpeg: "image",
            pdf: "image",
            svg: "image"
          };
          entries.push({
            name: item,
            type: "file",
            path: relPath,
            file_type: typeMap[ext] || "other",
            size: stat2.size
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
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}
function registerProjectResources(server) {
  const config = server.config;
  server.registerResource({
    uri: "xcode://project/structure",
    name: "Project File Tree",
    description: "Full project file tree with types and sizes",
    mimeType: "application/json",
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      const excludedPaths = config.projectConfig.excluded_paths || [];
      const tree = buildFileTree(config.projectDir, config.projectDir, excludedPaths);
      return {
        contents: [{
          uri: "xcode://project/structure",
          text: JSON.stringify({
            project: info.name,
            path: config.projectPath,
            targets: info.targets.map((t) => t.name),
            schemes: info.schemes.map((s) => s.name),
            file_tree: tree
          }, null, 2),
          mimeType: "application/json"
        }]
      };
    }
  });
  server.registerResource({
    uri: "xcode://project/settings",
    name: "Project Build Settings",
    description: "All build settings for all targets and configurations",
    mimeType: "application/json",
    handler: async () => {
      const info = getProjectInfo(config.projectPath);
      const settings = {};
      for (const target of info.targets) {
        settings[target.name] = {};
        for (const config2 of target.configurations) {
          settings[target.name][config2.name] = config2.settings;
        }
      }
      return {
        contents: [{
          uri: "xcode://project/settings",
          text: JSON.stringify(settings, null, 2),
          mimeType: "application/json"
        }]
      };
    }
  });
  server.registerResource({
    uri: "xcode://simulators/list",
    name: "Available Simulators",
    description: "List of all available simulators with their state",
    mimeType: "application/json",
    handler: async () => {
      const { getAvailableSimulators: getAvailableSimulators2 } = await import("./simulator_manager-EAE4YUGU.js");
      const simulators = await getAvailableSimulators2();
      return {
        contents: [{
          uri: "xcode://simulators/list",
          text: JSON.stringify(simulators, null, 2),
          mimeType: "application/json"
        }]
      };
    }
  });
}

// src/resources/build_log.ts
import { existsSync as existsSync6, readFileSync as readFileSync2, readdirSync as readdirSync4, statSync as statSync3 } from "fs";
import { join as join5 } from "path";
import { homedir as homedir3 } from "os";
function registerBuildLogResources(server) {
  const config = server.config;
  server.registerResource({
    uri: "xcode://build/latest_log",
    name: "Latest Build Log",
    description: "Full text of the most recent build log",
    mimeType: "text/plain",
    handler: async () => {
      const derivedData = join5(homedir3(), "Library", "Developer", "Xcode", "DerivedData");
      const projectName = config.projectPath.split("/").pop()?.replace(/\.xcodeproj$/, "") || "";
      const dirs = readdirSync4(derivedData);
      const matchingDir = dirs.find((d) => d.startsWith(projectName));
      if (!matchingDir) {
        return {
          contents: [{ uri: "xcode://build/latest_log", text: "No build logs found. Build the project first.", mimeType: "text/plain" }]
        };
      }
      const buildLogDir = join5(derivedData, matchingDir, "Logs", "Build");
      if (!existsSync6(buildLogDir)) {
        return {
          contents: [{ uri: "xcode://build/latest_log", text: "No build logs found.", mimeType: "text/plain" }]
        };
      }
      const logFiles = readdirSync4(buildLogDir).filter((f) => f.endsWith(".xcactivitylog")).map((f) => ({ name: f, time: statSync3(join5(buildLogDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
      if (logFiles.length === 0) {
        return {
          contents: [{ uri: "xcode://build/latest_log", text: "No build logs found.", mimeType: "text/plain" }]
        };
      }
      const logContent = readFileSync2(join5(buildLogDir, logFiles[0].name), "utf-8");
      return {
        contents: [{
          uri: "xcode://build/latest_log",
          text: logContent.slice(-5e4),
          mimeType: "text/plain"
        }]
      };
    }
  });
  server.registerResource({
    uri: "xcode://build/errors",
    name: "Latest Build Errors",
    description: "Parsed errors from the latest build",
    mimeType: "application/json",
    handler: async () => {
      const derivedData = join5(homedir3(), "Library", "Developer", "Xcode", "DerivedData");
      const projectName = config.projectPath.split("/").pop()?.replace(/\.xcodeproj$/, "") || "";
      const dirs = readdirSync4(derivedData);
      const matchingDir = dirs.find((d) => d.startsWith(projectName));
      if (!matchingDir) {
        return {
          contents: [{ uri: "xcode://build/errors", text: JSON.stringify({ errors: [], warnings: [] }), mimeType: "application/json" }]
        };
      }
      const buildLogDir = join5(derivedData, matchingDir, "Logs", "Build");
      if (!existsSync6(buildLogDir)) {
        return {
          contents: [{ uri: "xcode://build/errors", text: JSON.stringify({ errors: [], warnings: [] }), mimeType: "application/json" }]
        };
      }
      const logFiles = readdirSync4(buildLogDir).filter((f) => f.endsWith(".xcactivitylog")).map((f) => ({ name: f, time: statSync3(join5(buildLogDir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
      if (logFiles.length === 0) {
        return {
          contents: [{ uri: "xcode://build/errors", text: JSON.stringify({ errors: [], warnings: [] }), mimeType: "application/json" }]
        };
      }
      const logContent = readFileSync2(join5(buildLogDir, logFiles[0].name), "utf-8");
      const parsed = parseBuildOutput(logContent, "");
      return {
        contents: [{
          uri: "xcode://build/errors",
          text: JSON.stringify(parsed, null, 2),
          mimeType: "application/json"
        }]
      };
    }
  });
}

// src/prompts/fix_build_error.ts
function registerPrompts(server) {
  server.registerPrompt({
    name: "fix_build_error",
    description: "Given an Xcode build error and relevant file contents, generate a fix",
    arguments: [
      {
        name: "error_message",
        description: "The build error message from Xcode",
        required: true
      },
      {
        name: "file_path",
        description: "The file containing the error",
        required: true
      },
      {
        name: "file_content",
        description: "The content of the file with the error",
        required: true
      }
    ],
    handler: async (args) => {
      const errorMessage = args.error_message || "Unknown error";
      const filePath = args.file_path || "Unknown file";
      const fileContent = args.file_content || "";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `I'm getting a build error in my Xcode project and need help fixing it.

## Error
\`\`\`
${errorMessage}
\`\`\`

## File: ${filePath}
\`\`\`swift
${fileContent}
\`\`\`

Please analyze this build error and provide:
1. What is causing the error
2. The exact fix needed (show the corrected code)
3. Any related changes that might be needed

Focus on the specific error message and the code shown. Suggest the minimal change to fix it.`
          }
        }]
      };
    }
  });
  server.registerPrompt({
    name: "create_swift_feature",
    description: "Given a feature description, generate Swift implementation code",
    arguments: [
      {
        name: "feature_description",
        description: "Description of the feature to implement",
        required: true
      },
      {
        name: "existing_codebase",
        description: "Context about existing code patterns, architecture, and conventions",
        required: false
      }
    ],
    handler: async (args) => {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `I need to implement a new Swift feature in my Xcode project.

## Feature Description
${args.feature_description || "Not provided"}

## Existing Code Context
${args.existing_codebase || "Standard SwiftUI + Swift project"}

Please provide:
1. The complete Swift implementation code
2. File structure (what files to create/modify)
3. Any model/ViewModel/View changes needed
4. Error handling approach
5. Testing considerations

Follow Swift best practices, use proper error handling, and match modern Swift conventions.`
          }
        }]
      };
    }
  });
  server.registerPrompt({
    name: "write_xctest",
    description: "Given a class name and methods, generate comprehensive XCTest cases",
    arguments: [
      {
        name: "class_name",
        description: "The class/struct to write tests for",
        required: true
      },
      {
        name: "method_names",
        description: "Comma-separated list of methods to test",
        required: true
      },
      {
        name: "class_content",
        description: "The source code of the class being tested",
        required: true
      }
    ],
    handler: async (args) => {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `I need XCTest cases for a Swift class in my Xcode project.

## Class to Test
**Name:** ${args.class_name || "Unknown"}
**Methods:** ${args.method_names || "All methods"}

## Source Code
\`\`\`swift
${args.class_content || "Not provided"}
\`\`\`

Please generate comprehensive XCTest cases:
1. Test initialization and setup
2. Test each method with normal inputs
3. Test edge cases (empty, nil, boundary values)
4. Test error conditions
5. Follow Given-When-Then pattern in comments
6. Use proper setUp/tearDown
7. Test async operations with XCTestExpectation if needed

Generate complete, compilable test code.`
          }
        }]
      };
    }
  });
  server.registerPrompt({
    name: "review_swift_code",
    description: "Review Swift code for best practices, performance, and potential issues",
    arguments: [
      {
        name: "file_content",
        description: "The Swift source code to review",
        required: true
      },
      {
        name: "file_path",
        description: "The file path for context",
        required: false
      }
    ],
    handler: async (args) => {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Please review this Swift code for best practices, performance, and potential issues.

## File: ${args.file_path || "Unknown"}
\`\`\`swift
${args.file_content || "Not provided"}
\`\`\`

Please review for:
1. Swift best practices and conventions
2. Performance concerns (retain cycles, unnecessary copies, etc.)
3. Memory management issues
4. Thread safety / actor isolation
5. Error handling completeness
6. Optional handling safety
7. Code organization and readability
8. API design improvements
9. Testing considerations
10. Specific improvement suggestions with code examples

Focus on actionable, specific feedback with code examples.`
          }
        }]
      };
    }
  });
}

// src/server.ts
var XcodeMCPServer = class {
  server;
  tools = /* @__PURE__ */ new Map();
  resources = /* @__PURE__ */ new Map();
  prompts = /* @__PURE__ */ new Map();
  config;
  constructor() {
    this.server = new Server(
      {
        name: "xcode-mcp",
        version: "1.0.0"
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        }
      }
    );
    this.setupRequestHandlers();
    this.setupLifecycleHandlers();
  }
  setupRequestHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const toolList = Array.from(this.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }));
      return { tools: toolList };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const tool = this.tools.get(toolName);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
      }
      try {
        return await tool.handler(request.params.arguments || {});
      } catch (error) {
        logger.error(`Tool ${toolName} error:`, error);
        if (error instanceof McpError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({
            code: "TOOL_ERROR",
            message: msg,
            suggestion: "Check the tool arguments and try again."
          }) }],
          isError: true
        };
      }
    });
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resourceList = Array.from(this.resources.values()).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType
      }));
      return { resources: resourceList };
    });
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const resource = this.resources.get(uri);
      if (!resource) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown resource: ${uri}`);
      }
      return await resource.handler(uri);
    });
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const promptList = Array.from(this.prompts.values()).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments
      }));
      return { prompts: promptList };
    });
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const promptName = request.params.name;
      const prompt = this.prompts.get(promptName);
      if (!prompt) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${promptName}`);
      }
      return await prompt.handler(request.params.arguments || {});
    });
  }
  setupLifecycleHandlers() {
    process.on("SIGINT", async () => {
      logger.info("Received SIGINT, shutting down...");
      killAllChildProcesses();
      await this.server.close();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM, shutting down...");
      killAllChildProcesses();
      await this.server.close();
      process.exit(0);
    });
    process.on("uncaughtException", (error) => {
      logger.error("Uncaught exception:", error);
      killAllChildProcesses();
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled rejection:", reason);
    });
  }
  registerTool(tool) {
    this.tools.set(tool.name, tool);
  }
  registerResource(resource) {
    this.resources.set(resource.uri, resource);
  }
  registerPrompt(prompt) {
    this.prompts.set(prompt.name, prompt);
  }
  async init() {
    logger.info("Loading configuration...");
    this.config = await loadConfig();
    logger.info(`Config loaded. Project: ${this.config.projectPath}`);
    if (this.config.defaultScheme) {
      logger.info(`Default scheme: ${this.config.defaultScheme}`);
    }
  }
  registerAllTools() {
    registerProjectTools(this);
    registerBuildTools(this);
    registerSimulatorTools(this);
    registerTestingTools(this);
    registerCodeTools(this);
    registerSigningTools(this);
    registerDiagnosticsTools(this);
    registerProjectResources(this);
    registerBuildLogResources(this);
    registerPrompts(this);
  }
  async start() {
    this.registerAllTools();
    logger.info(`Registered ${this.tools.size} tools, ${this.resources.size} resources, ${this.prompts.size} prompts`);
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("xcode-mcp server started on stdio");
  }
};

// src/index.ts
async function main() {
  const logLevel = process.env.XCODE_MCP_LOG_LEVEL || "info";
  setLogLevel(logLevel);
  logger.info("Starting xcode-mcp server...");
  const server = new XcodeMCPServer();
  try {
    await server.init();
    await server.start();
  } catch (error) {
    logger.error("Failed to start server:", error);
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      code: "SERVER_ERROR",
      message,
      suggestion: "Check your XCODE_PROJECT_PATH and ensure Xcode is installed."
    }));
    process.exit(1);
  }
}
main();
