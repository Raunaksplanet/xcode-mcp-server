import { logger } from './logger.js';

export interface MCPError {
  code: string;
  message: string;
  details?: string;
  suggestion: string;
}

export function xcodeNotFound(): MCPError {
  return {
    code: 'XCODE_NOT_FOUND',
    message: 'Xcode is not installed or not found in PATH',
    suggestion: 'Install Xcode from the Mac App Store, then run: sudo xcode-select --install\n' +
      'Then accept the license: sudo xcodebuild -license accept',
  };
}

export function projectNotFound(path: string): MCPError {
  return {
    code: 'PROJECT_NOT_FOUND',
    message: `Xcode project not found at: ${path}`,
    suggestion: 'Verify XCODE_PROJECT_PATH is correct. The path should end with .xcodeproj or .xcworkspace.\n' +
      'Run: ls -la "$XCODE_PROJECT_PATH" to check.',
  };
}

export function buildFailed(details: string): MCPError {
  return {
    code: 'BUILD_FAILED',
    message: 'Xcode build failed',
    details,
    suggestion: 'Check the build errors above. Common fixes:\n' +
      '1. Resolve Swift compilation errors\n' +
      '2. Check code signing configuration\n' +
      '3. Ensure all dependencies are resolved\n' +
      '4. Try: xcodebuild -resolvePackageDependencies',
  };
}

export function simulatorTimeout(udid: string): MCPError {
  return {
    code: 'SIMULATOR_TIMEOUT',
    message: `Simulator ${udid} did not boot within timeout`,
    suggestion: 'Try: xcrun simctl erase ${udid} && xcrun simctl boot ${udid}\n' +
      'Or check simulator status: xcrun simctl list | grep -E "(Booted|Shutdown)"',
  };
}

export function fileNotFound(path: string): MCPError {
  return {
    code: 'FILE_NOT_FOUND',
    message: `File not found: ${path}`,
    suggestion: 'Verify the file path is correct and relative to the project root.',
  };
}

export function pathTraversalDetected(path: string): MCPError {
  return {
    code: 'PATH_TRAVERSAL',
    message: `Path traversal detected: ${path}`,
    suggestion: 'All file paths must remain within the project directory. Use paths relative to the project root.',
  };
}

export function invalidInput(field: string, reason: string): MCPError {
  return {
    code: 'INVALID_INPUT',
    message: `Invalid input for "${field}": ${reason}`,
    suggestion: 'Check the tool documentation for correct input format and types.',
  };
}

export function timeoutError(operation: string, timeout: number): MCPError {
  return {
    code: 'TIMEOUT',
    message: `Operation "${operation}" timed out after ${timeout}s`,
    suggestion: 'The operation took too long. Try increasing the timeout via environment variables:\n' +
      `XCODE_MCP_BUILD_TIMEOUT or XCODE_MCP_TEST_TIMEOUT.`,
  };
}

export function testFailure(details: string): MCPError {
  return {
    code: 'TEST_FAILURE',
    message: 'Tests failed',
    details,
    suggestion: 'Check the test failures above. Common fixes:\n' +
      '1. Fix assertion failures in test code\n' +
      '2. Ensure test targets are configured correctly\n' +
      '3. Check for simulator/device compatibility',
  };
}

export function fromCLIError(operation: string, stderr: string, exitCode: number | null): MCPError {
  logger.error(`CLI error in ${operation}: exit=${exitCode}, stderr=${stderr.slice(0, 500)}`);

  if (stderr.includes('xcode-select: error') || stderr.includes('developer path cannot be found')) {
    return xcodeNotFound();
  }
  if (stderr.includes('No such file or directory') && stderr.includes('.xcodeproj')) {
    return projectNotFound(stderr);
  }
  if (stderr.includes('error:') && (stderr.includes('build') || stderr.includes('compile'))) {
    return buildFailed(stderr.slice(0, 2000));
  }
  if (stderr.includes('timed out') || stderr.includes('Timeout')) {
    return timeoutError(operation, 0);
  }

  return {
    code: 'CLI_ERROR',
    message: `${operation} failed with exit code ${exitCode}`,
    details: stderr.slice(0, 2000),
    suggestion: 'Check the error details above and retry.',
  };
}
