# xcode-mcp Tools Reference

## Project Management

### xcode_open_project
Open an Xcode project or workspace in Xcode.

**Inputs:**
- `project_path` (string, optional) — Path to .xcodeproj or .xcworkspace. Defaults to `XCODE_PROJECT_PATH`.

**Returns:** `{ success: boolean, path: string }`

### xcode_get_project_info
Get detailed information about the Xcode project, including targets, schemes, configurations, and deployment settings.

**Inputs:**
- `project_path` (string, optional) — Path to .xcodeproj.

**Returns:** Project info with targets, schemes, configurations, deployment target, bundle ID, Swift version.

### xcode_list_targets
List all targets in the project.

**Inputs:** None

**Returns:** Array of targets with name, type, bundle_id, deployment_target, source_files_count.

### xcode_list_schemes
List all schemes.

**Inputs:** None

**Returns:** Array of schemes with name, is_shared, has_tests, build_configuration.

### xcode_list_files
List files in the project.

**Inputs:**
- `target` (string, optional) — Filter by target name.
- `file_type` (string, optional) — Filter: swift/objc/storyboard/xcassets/plist/xib/strings/json/entitlements.

**Returns:** Array of file entries with path, type, target_membership.

### xcode_add_file
Add a file to the Xcode project.

**Inputs:**
- `file_path` (string, required) — Path relative to project root.
- `target` (string, required) — Target name.
- `content` (string, optional) — File content. Creates file if missing.

**Returns:** `{ success: boolean, file_path: string, target: string }`

### xcode_remove_file
Remove a file from the project.

**Inputs:**
- `file_path` (string, required) — Path relative to project root.
- `target` (string, required) — Target name.
- `delete_from_disk` (boolean, optional, default: false) — Also delete physical file.

**Returns:** `{ success: boolean, file_path: string, target: string, deleted_from_disk: boolean }`

### xcode_get_build_settings
Get resolved build settings for a target and configuration.

**Inputs:**
- `target` (string, required) — Target name.
- `configuration` (string, optional, default: Release) — Debug/Release.

**Returns:** Key-value pairs of all resolved build settings.

### xcode_set_build_setting
Modify a build setting in the project.

**Inputs:**
- `target` (string, required)
- `configuration` (string, required)
- `key` (string, required) — Setting key (e.g., PRODUCT_BUNDLE_IDENTIFIER).
- `value` (string, required) — Setting value.

**Returns:** `{ success: boolean, target, configuration, key, value }`

### xcode_resolve_packages
Resolve Swift Package Manager dependencies.

**Inputs:** None

**Returns:** `{ packages: string[], output: string }`

---

## Build Tools

### xcode_build
Build the project.

**Inputs:**
- `scheme` (string, optional) — Defaults to XCODE_DEFAULT_SCHEME.
- `configuration` (string, optional, default: Debug) — Debug/Release.
- `destination` (string, optional) — Platform destination.
- `clean` (boolean, optional, default: false) — Clean build.
- `derived_data_path` (string, optional) — Custom DerivedData path.

**Returns:** `{ success, scheme, configuration, build_time_seconds, errors[], warnings[], output_log }`

### xcode_build_for_testing
Build for testing.

**Inputs:**
- `scheme` (string, optional)
- `destination` (string, optional)

**Returns:** Build result with errors and warnings.

### xcode_archive
Archive and optionally export the project.

**Inputs:**
- `scheme` (string, optional)
- `export_options` (object, optional) — `{ method: string, teamID: string, signingStyle: string }`

**Returns:** `{ success, archivePath?, exportPath?, errors[], warnings[] }`

### xcode_clean
Clean build artifacts.

**Inputs:**
- `scheme` (string, optional)
- `derived_data` (boolean, optional, default: false) — Also wipe DerivedData.

**Returns:** `{ success: boolean, results: string[] }`

### xcode_get_build_errors
Parse errors and warnings from the most recent build log.

**Inputs:** None

**Returns:** `{ errors: BuildIssue[], warnings: BuildIssue[] }`

### xcode_get_analyzer_results
Run Clang Static Analyzer.

**Inputs:**
- `scheme` (string, optional)
- `target` (string, optional)

**Returns:** `{ issues: BuildIssue[], output: string }`

---

## Simulator Control

### xcode_list_simulators
List all available simulators.

**Returns:** Array of simulators with udid, name, state, os_version, device_type, is_available.

### xcode_boot_simulator
Boot a simulator.

**Inputs:**
- `udid` (string, required) — UDID or name.

**Returns:** `{ success: boolean, udid: string }`

### xcode_shutdown_simulator
Shutdown a simulator.

**Inputs:**
- `udid` (string, required)

**Returns:** `{ success: boolean, udid: string }`

### xcode_install_app
Install an app on a simulator.

**Inputs:**
- `udid` (string, required)
- `app_path` (string, required)

### xcode_launch_app
Launch an app on a simulator.

**Inputs:**
- `udid` (string, required)
- `bundle_id` (string, required)
- `arguments` (string[], optional)
- `environment` (object, optional)

**Returns:** `{ success: boolean, pid: number }`

### xcode_terminate_app
Terminate an app on a simulator.

**Inputs:**
- `udid` (string, required)
- `bundle_id` (string, required)

### xcode_get_simulator_logs
Get logs from a simulator.

**Inputs:**
- `udid` (string, required)
- `bundle_id` (string, optional) — Filter by bundle.
- `lines` (number, optional, default: 100)
- `filter` (string, optional) — Log predicate.

**Returns:** Array of log entries with timestamp and message.

### xcode_screenshot_simulator
Take a screenshot.

**Inputs:**
- `udid` (string, required)
- `output_path` (string, optional)

**Returns:** `{ success: boolean, path: string }`

### xcode_record_simulator
Record video.

**Inputs:**
- `udid` (string, required)
- `output_path` (string, required)
- `duration_seconds` (number, optional, default: 10)

### xcode_open_url_simulator
Open a URL for deep link testing.

**Inputs:**
- `udid` (string, required)
- `url` (string, required)

### xcode_set_simulator_location
Set GPS location.

**Inputs:**
- `udid` (string, required)
- `latitude` (number, required)
- `longitude` (number, required)

### xcode_push_notification_simulator
Simulate a push notification.

**Inputs:**
- `udid` (string, required)
- `bundle_id` (string, required)
- `payload` (object, required) — APNs payload JSON.

### xcode_reset_simulator
Reset simulator to factory state.

**Inputs:**
- `udid` (string, required)

---

## Testing Tools

### xcode_run_tests
Run all tests.

**Inputs:**
- `scheme` (string, optional)
- `destination` (string, optional)
- `test_plan` (string, optional)
- `test_filter` (string, optional) — "Target/Class/method"
- `parallel` (boolean, optional, default: false)
- `result_bundle_path` (string, optional)

**Returns:** `{ total_tests, passed, failed, skipped, duration_seconds, failures[] }`

### xcode_run_single_test
Run a single test.

**Inputs:**
- `scheme` (string, optional)
- `destination` (string, optional)
- `test_identifier` (string, required) — "Target/Class/method"

### xcode_get_test_results
Parse xcresult bundle.

**Inputs:**
- `result_bundle_path` (string, optional)

### xcode_get_code_coverage
Get coverage report.

**Inputs:**
- `result_bundle_path` (string, optional)

---

## Code Tools

### xcode_read_file
Read file content.

**Inputs:**
- `file_path` (string, required) — Relative to project root.

**Returns:** content, line_count, file_size, last_modified.

### xcode_write_file
Write file content. Auto-adds to project if file is new.

**Inputs:**
- `file_path` (string, required)
- `content` (string, required)
- `create_if_missing` (boolean, optional, default: true)

### xcode_edit_file
Find and replace in file.

**Inputs:**
- `file_path` (string, required)
- `old_content` (string, required)
- `new_content` (string, required)

### xcode_get_swift_symbols
Extract Swift symbols (classes, structs, enums, protocols, functions, properties).

**Inputs:**
- `file_path` (string, required)

### xcode_format_file
Format Swift code with swift-format.

**Inputs:**
- `file_path` (string, required)

### xcode_search_in_project
Search across project files.

**Inputs:**
- `query` (string, required)
- `file_type` (string, optional)
- `case_sensitive` (boolean, optional, default: false)
- `regex` (boolean, optional, default: false)

---

## Signing Tools

### xcode_list_certificates
List signing certificates.

### xcode_list_provisioning_profiles
List provisioning profiles.

### xcode_set_signing
Configure signing.

**Inputs:**
- `target` (string, required)
- `team_id` (string, required)
- `bundle_id` (string, required)
- `profile_name` (string, optional)
- `automatic` (boolean, optional, default: true)

### xcode_validate_signing
Verify code signature.

**Inputs:**
- `app_path` (string, required)

---

## Diagnostics

### xcode_get_warnings
Get all warnings from latest build.

### xcode_profile_app
Profile with Instruments.

**Inputs:**
- `scheme` (string, optional)
- `destination` (string, optional)
- `template` (string, optional, default: Time Profiler)
- `duration_seconds` (number, optional, default: 10)

### xcode_add_spm_package
Add Swift Package Manager dependency.

**Inputs:**
- `url` (string, required)
- `version_requirement` (object, optional) — `{ type: 'exact'|'upToNextMajorVersion'|'branch', value: string }`
- `target` (string, required)

---

## Error Codes

| Code | Meaning |
|------|---------|
| `XCODE_NOT_FOUND` | Xcode not installed |
| `PROJECT_NOT_FOUND` | Xcode project not found at path |
| `BUILD_FAILED` | Build failed |
| `SIMULATOR_TIMEOUT` | Simulator boot timeout |
| `FILE_NOT_FOUND` | File not found |
| `PATH_TRAVERSAL` | Path traversal detected |
| `INVALID_INPUT` | Invalid tool input |
| `TIMEOUT` | Operation timed out |
| `TEST_FAILURE` | Tests failed |
| `CLI_ERROR` | CLI command error |
| `TOOL_ERROR` | Internal tool error |
