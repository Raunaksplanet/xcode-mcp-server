# xcode-mcp

MCP (Model Context Protocol) server that bridges AI assistants with Xcode, enabling full control over Xcode projects, builds, simulators, testing, and debugging — all without touching Xcode manually.

**macOS only. Xcode 14+ required. Node 18+ required.**

## Quick Install

**macOS / Linux:**
```bash
curl -sL https://raw.githubusercontent.com/Raunaksplanet/xcode-mcp-server/main/install.sh | bash
# or locally:
./install.sh
```

**Windows (PowerShell):**
```powershell
.\install.ps1
```

The installer: checks prerequisites, installs deps, builds, prompts for your Xcode project path, and registers with OpenCode automatically.

## Manual Setup

```bash
npm install
npm run build
export XCODE_PROJECT_PATH=/path/to/YourApp.xcodeproj
npm start
```

## OpenCode Integration

Clone the repo and add to `~/.config/opencode/opencode.json`:

```json
{
  "mcpServers": {
    "xcode": {
      "command": "node",
      "args": ["path/to/xcode-mcp/dist/index.js"],
      "env": {
        "XCODE_PROJECT_PATH": "/path/to/YourApp.xcodeproj",
        "XCODE_DEFAULT_SCHEME": "YourApp"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XCODE_PROJECT_PATH` | Yes | Path to `.xcodeproj` or `.xcworkspace` |
| `XCODE_DEFAULT_SCHEME` | No | Default scheme for build/test operations |
| `XCODE_DEFAULT_SIMULATOR` | No | Default simulator UDID or name |
| `XCODE_DERIVED_DATA_PATH` | No | Custom DerivedData path |
| `XCODE_MCP_LOG_LEVEL` | No | Log level: debug/info/warn/error (default: info) |
| `XCODE_MCP_BUILD_TIMEOUT` | No | Build timeout in seconds (default: 300) |
| `XCODE_MCP_TEST_TIMEOUT` | No | Test timeout in seconds (default: 600) |

## Configuration File

Place `.xcode-mcp.json` next to your `.xcodeproj`:

```json
{
  "default_scheme": "MyApp",
  "default_simulator": "iPhone 16 Pro",
  "excluded_paths": ["Pods", "vendor"],
  "build_pre_hooks": ["echo 'Starting build...'"],
  "build_post_hooks": ["echo 'Build complete!'"],
  "custom_destinations": ["platform=iOS Simulator,name=iPhone 16,OS=latest"]
}
```

## Available Tools

### Project Management
- `xcode_open_project` — Open project in Xcode
- `xcode_get_project_info` — Get project info (targets, schemes, configs)
- `xcode_list_targets` — List all targets
- `xcode_list_schemes` — List all schemes
- `xcode_list_files` — List project files
- `xcode_add_file` — Add file to project
- `xcode_remove_file` — Remove file from project
- `xcode_get_build_settings` — Get resolved build settings
- `xcode_set_build_setting` — Modify build settings
- `xcode_resolve_packages` — Resolve SPM dependencies

### Build Tools
- `xcode_build` — Build the project
- `xcode_build_for_testing` — Build for testing
- `xcode_archive` — Archive for distribution
- `xcode_clean` — Clean build artifacts
- `xcode_get_build_errors` — Parse build errors/warnings
- `xcode_get_analyzer_results` — Run static analyzer

### Simulator Control
- `xcode_list_simulators` — List available simulators
- `xcode_boot_simulator` — Boot a simulator
- `xcode_shutdown_simulator` — Shutdown simulator
- `xcode_install_app` — Install app on simulator
- `xcode_launch_app` — Launch app on simulator
- `xcode_terminate_app` — Terminate app
- `xcode_get_simulator_logs` — Fetch simulator logs
- `xcode_screenshot_simulator` — Take screenshot
- `xcode_record_simulator` — Record video
- `xcode_open_url_simulator` — Open URL (deep link testing)
- `xcode_set_simulator_location` — Set location
- `xcode_push_notification_simulator` — Simulate push notification
- `xcode_reset_simulator` — Reset to factory state

### Testing
- `xcode_run_tests` — Run all tests
- `xcode_run_single_test` — Run specific test
- `xcode_get_test_results` — Parse xcresult bundle
- `xcode_get_code_coverage` — Get coverage report

### Code Management
- `xcode_read_file` — Read file content
- `xcode_write_file` — Write file content
- `xcode_edit_file` — Find and replace in file
- `xcode_get_swift_symbols` — Extract Swift symbols
- `xcode_format_file` — Format with swift-format
- `xcode_search_in_project` — Search across project files

### Code Signing
- `xcode_list_certificates` — List signing certificates
- `xcode_list_provisioning_profiles` — List provisioning profiles
- `xcode_set_signing` — Configure signing settings
- `xcode_validate_signing` — Verify code signature

### Diagnostics
- `xcode_get_warnings` — Get build warnings
- `xcode_profile_app` — Profile with Instruments
- `xcode_add_spm_package` — Add SPM dependency

## Resources

- `xcode://project/structure` — Project file tree
- `xcode://project/settings` — All build settings
- `xcode://build/latest_log` — Latest build log
- `xcode://build/errors` — Parsed build errors
- `xcode://simulators/list` — Available simulators

## Prompts

- `fix_build_error` — Fix a build error with context
- `create_swift_feature` — Implement a Swift feature
- `write_xctest` — Generate XCTest cases
- `review_swift_code` — Swift best practices review

## Architecture

```
xcode-mcp/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # MCP server setup
│   ├── tools/            # Tool implementations
│   ├── lib/              # Core libraries
│   │   ├── xcode_runner.ts    # xcodebuild/xcrun wrappers
│   │   ├── pbxproj_parser.ts  # PBXProject parser
│   │   ├── pbxproj_writer.ts  # PBXProject writer
│   │   ├── simulator_manager.ts # simctl wrapper
│   │   ├── process_manager.ts  # Process lifecycle
│   │   ├── logger.ts           # Structured logging
│   │   ├── error_handler.ts    # Error mapping
│   │   └── config.ts          # Configuration
│   ├── types/            # TypeScript type definitions
│   ├── resources/        # MCP resource providers
│   └── prompts/          # MCP prompt templates
├── package.json
└── tsconfig.json
```

## Security

- All file paths are validated against the project root
- Command injection prevented via `execFile` with args arrays
- Sensitive data (certificates, keys) never logged
- Concurrent xcodebuild calls are queued (max 2)
- Path traversal detection on all file operations

## License

MIT
