import { existsSync } from 'node:fs';
import type { XcodeMCPServer } from '../server.js';
import { xcodebuild } from '../lib/xcode_runner.js';
import { logger } from '../lib/logger.js';
import { testFailure } from '../lib/error_handler.js';
import { projectFlag, requireSchemeName, requireNonEmptyString, optionalString } from '../lib/validation.js';
import type { TestResult, TestFailure } from '../types/xcodebuild.js';

function parseTestResults(stdout: string, stderr: string): TestResult {
  const failures: TestFailure[] = [];
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationSeconds = 0;
  const output = stdout + '\n' + stderr;

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

  const lines = output.split('\n');
  const seenFailures = new Set<string>();
  const addFailure = (failure: TestFailure): void => {
    // The two patterns below can match the same line: dedupe on identity.
    const identity = `${failure.className}\u0000${failure.testName}\u0000${failure.file ?? ''}\u0000${failure.line ?? ''}\u0000${failure.message}`;
    if (seenFailures.has(identity)) return;
    seenFailures.add(identity);
    failures.push(failure);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';

    const failMatch = line.match(/^\s*(-\[(\w+(?:\s+\w+)?)\s+(\w+)\])|(?:FAIL|error:)\s*(?:-\[(\w+(?:\s+\w+)?)\s+(\w+)\])/);
    if (failMatch) {
      const testName = failMatch[1] || `-${failMatch[4]} ${failMatch[5]}`;
      const nextLine = lines[i + 1] || '';
      const fileMatch = nextLine.match(/(.+?):(\d+):\s*(.+)/);
      addFailure({
        testName: testName.replace(/^-\s*\[|\]$/g, '').trim(),
        className: failMatch[2] || failMatch[4] || '',
        file: fileMatch?.[1],
        line: fileMatch?.[2] ? parseInt(fileMatch[2], 10) : undefined,
        message: fileMatch?.[3] || nextLine,
      });
    }

    const modernFailMatch = line.match(/(\w[\w\/]+)\s*:\s*(?:error|FAIL).*?at\s+(.+?):(\d+)/);
    if (modernFailMatch) {
      addFailure({
        testName: modernFailMatch[1]!,
        className: modernFailMatch[1]!.split('/')[0] || '',
        file: modernFailMatch[2],
        line: parseInt(modernFailMatch[3]!, 10),
        message: line,
      });
    }
  }

  if (totalTests === 0 && passed === 0) {
      for (const line of lines) {
      const testMatch = line.match(/Test\s+case\s+'(?:-\[(\w+)\s+(\w+)\]|(\w+)\.(\w+))'\s+(?:passed|failed)/);
      if (testMatch) {
        totalTests++;
        if (line.includes('passed')) passed++;
        else if (line.includes('failed')) failed++;
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
    outputLog: output.slice(-10000),
  };
}

export function registerTestingTools(server: XcodeMCPServer): void {
  const config = server.config;

  server.registerTool({
    name: 'xcode_run_tests',
    description: 'Run tests using xcodebuild',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to test',
        },
        destination: {
          type: 'string',
          description: 'Test destination (e.g., "platform=iOS Simulator,name=iPhone 16")',
        },
        test_plan: {
          type: 'string',
          description: 'Test plan name',
        },
        test_filter: {
          type: 'string',
          description: 'Test filter (e.g., "TargetName/ClassName/testMethodName")',
        },
        parallel: {
          type: 'boolean',
          description: 'Run tests in parallel',
          default: false,
        },
        result_bundle_path: {
          type: 'string',
          description: 'Custom path for xcresult bundle',
        },
      },
    },
    handler: async (args) => {
      const rawScheme = (args.scheme as string) || config.defaultScheme;
      if (!rawScheme) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'NO_SCHEME',
            message: 'No scheme specified and XCODE_DEFAULT_SCHEME is not set',
            suggestion: 'Pass a scheme argument or set XCODE_DEFAULT_SCHEME.',
          }) }],
          isError: true,
        };
      }
      const scheme = requireSchemeName(rawScheme);

      const [projFlag, projPath] = projectFlag(config.projectPath);
      const buildArgs = [
        projFlag, projPath,
        '-scheme', scheme,
        '-destination', (args.destination as string) || 'platform=iOS Simulator,name=iPhone 16',
        'test',
      ];

      const testPlan = optionalString(args.test_plan, 'test_plan', 256);
      if (testPlan) {
        buildArgs.push('-testPlan', testPlan);
      }

      const testFilter = optionalString(args.test_filter, 'test_filter', 512);
      if (testFilter) {
        buildArgs.push('-only-testing', testFilter);
      }

      if (args.parallel === true) {
        buildArgs.push('-parallel-testing-enabled', 'YES');
      } else {
        buildArgs.push('-parallel-testing-enabled', 'NO');
      }

      const resultBundlePath = optionalString(args.result_bundle_path, 'result_bundle_path');
      if (resultBundlePath) {
        buildArgs.push('-resultBundlePath', resultBundlePath);
      }

      try {
        const startTime = Date.now();
        const result = await xcodebuild(buildArgs, {
          timeout: config.testTimeout * 1000,
          onProgress: (line) => logger.info(`[test] ${line}`),
        });

        const duration = (Date.now() - startTime) / 1000;
        const testResults = parseTestResults(result.stdout, result.stderr);
        testResults.durationSeconds = duration;

        // A run that parsed zero tests is inconclusive, never a success.
        const success = testResults.totalTests > 0 && testResults.failed === 0;

        return {
          content: [{ type: 'text', text: JSON.stringify(testResults, null, 2) }],
          isError: !success,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(testFailure(error instanceof Error ? error.message : String(error))) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_test_results',
    description: 'Get parsed test results from an xcresult bundle',
    inputSchema: {
      type: 'object',
      properties: {
        result_bundle_path: {
          type: 'string',
          description: 'Path to .xcresult bundle (defaults to latest)',
        },
      },
    },
    handler: async (args) => {
      try {
        const { findLatestXcresult } = await import('../lib/build_log.js');
        const explicitPath = optionalString(args.result_bundle_path, 'result_bundle_path');
        if (explicitPath && !explicitPath.endsWith('.xcresult')) {
          const { invalidInput } = await import('../lib/error_handler.js');
          throw invalidInput('result_bundle_path', 'Must point to a .xcresult bundle.');
        }
        let xcresultPath = explicitPath;

        if (!xcresultPath) {
          xcresultPath = findLatestXcresult(config.projectPath);
        }

        if (!xcresultPath || !existsSync(xcresultPath)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              message: 'No xcresult bundle found. Run tests first.',
            }) }],
          };
        }

        const { xcrun } = await import('../lib/xcode_runner.js');
        const result = await xcrun('xcresulttool', ['get', '--format', 'json', '--path', xcresultPath]);
        const parsed = JSON.parse(result.stdout);

        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'TEST_RESULTS_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure tests have been run and the xcresult path is valid.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_code_coverage',
    description: 'Get code coverage report from latest test run',
    inputSchema: {
      type: 'object',
      properties: {
        result_bundle_path: {
          type: 'string',
          description: 'Path to .xcresult bundle',
        },
      },
    },
    handler: async (args) => {
      try {
        const { xcrun } = await import('../lib/xcode_runner.js');
        const { findLatestXcresult } = await import('../lib/build_log.js');
        const explicitPath = optionalString(args.result_bundle_path, 'result_bundle_path');
        if (explicitPath && !explicitPath.endsWith('.xcresult')) {
          const { invalidInput } = await import('../lib/error_handler.js');
          throw invalidInput('result_bundle_path', 'Must point to a .xcresult bundle.');
        }
        const resultPath = explicitPath;

        if (resultPath && existsSync(resultPath)) {
          const report = await xcrun('xccov', ['view', '--report', '--path', resultPath]);
          const jsonReport = await xcrun('xccov', ['view', '--report', '--json', '--path', resultPath]);
          let coverageData: unknown;
          try {
            coverageData = JSON.parse(jsonReport.stdout);
          } catch {
            throw new Error('Failed to parse xccov JSON output.');
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({
              summary: report.stdout.slice(0, 2000),
              data: coverageData,
            }, null, 2) }],
          };
        }

        const latestPath = findLatestXcresult(config.projectPath);
        if (latestPath) {
          const report = await xcrun('xccov', ['view', '--report', '--path', latestPath]);
          return {
            content: [{ type: 'text', text: JSON.stringify({ report: report.stdout }) }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ message: 'No coverage data found. Run tests with code coverage enabled.' }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'COVERAGE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure code coverage is enabled in your scheme and tests have been run.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_run_single_test',
    description: 'Run a single test method',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description: 'Scheme to test',
        },
        destination: {
          type: 'string',
          description: 'Test destination',
        },
        test_identifier: {
          type: 'string',
          description: 'Test identifier (e.g., "TargetName/ClassName/testMethodName")',
        },
      },
      required: ['test_identifier'],
    },
    handler: async (args) => {
      const rawScheme = (args.scheme as string) || config.defaultScheme;
      if (!rawScheme) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'NO_SCHEME',
            message: 'No scheme specified',
            suggestion: 'Pass a scheme argument.',
          }) }],
          isError: true,
        };
      }
      const scheme = requireSchemeName(rawScheme);
      const testIdentifier = requireNonEmptyString(args.test_identifier, 'test_identifier', 512);

      const [projFlag, projPath] = projectFlag(config.projectPath);
      const buildArgs = [
        projFlag, projPath,
        '-scheme', scheme,
        '-destination', (args.destination as string) || 'platform=iOS Simulator,name=iPhone 16',
        'test',
        '-only-testing', testIdentifier,
      ];

      try {
        const result = await xcodebuild(buildArgs, {
          timeout: config.testTimeout * 1000,
          onProgress: (line) => logger.info(`[test] ${line}`),
        });

        const testResults = parseTestResults(result.stdout, result.stderr);
        return {
          content: [{ type: 'text', text: JSON.stringify(testResults, null, 2) }],
          isError: testResults.failed > 0,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(testFailure(error instanceof Error ? error.message : String(error))) }],
          isError: true,
        };
      }
    },
  });
}
