import type { XcodeMCPServer } from '../server.js';
import {
  getAvailableSimulators,
  bootSimulator,
  shutdownSimulator,
  findSimulator,
  installApp,
  launchApp,
  terminateApp,
  getSimulatorLogs,
  screenshotSimulator,
  recordSimulator,
  openURL,
  setSimulatorLocation,
  pushNotification,
  resetSimulator,
} from '../lib/simulator_manager.js';
export function registerSimulatorTools(server: XcodeMCPServer): void {

  server.registerTool({
    name: 'xcode_list_simulators',
    description: 'List all available simulators grouped by OS',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const simulators = await getAvailableSimulators();
      return {
        content: [{ type: 'text', text: JSON.stringify(simulators, null, 2) }],
      };
    },
  });

  server.registerTool({
    name: 'xcode_boot_simulator',
    description: 'Boot a simulator by UDID',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID or name' },
      },
      required: ['udid'],
    },
    handler: async (args) => {
      const query = args.udid as string;
      let udid = query;

      if (query.length < 36) {
        const device = await findSimulator(query);
        if (!device) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              code: 'SIMULATOR_NOT_FOUND',
              message: `No simulator found matching: ${query}`,
              suggestion: 'Use xcode_list_simulators to see available simulators.',
            }) }],
            isError: true,
          };
        }
        udid = device.udid;
      }

      try {
        const result = await bootSimulator(udid);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, udid: result }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SIMULATOR_BOOT_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Try erasing the simulator first: xcrun simctl erase udid',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_shutdown_simulator',
    description: 'Shutdown a simulator by UDID',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
      },
      required: ['udid'],
    },
    handler: async (args) => {
      const udid = args.udid as string;
      try {
        await shutdownSimulator(udid);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, udid }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SIMULATOR_SHUTDOWN_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Try forcing shutdown: xcrun simctl shutdown udid',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_install_app',
    description: 'Install an app on a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        app_path: { type: 'string', description: 'Path to .app bundle' },
      },
      required: ['udid', 'app_path'],
    },
    handler: async (args) => {
      try {
        await installApp(args.udid as string, args.app_path as string);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'INSTALL_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the app path is correct and the simulator is booted.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_launch_app',
    description: 'Launch an app on a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        bundle_id: { type: 'string', description: 'Bundle identifier to launch' },
        arguments: { type: 'array', items: { type: 'string' }, description: 'Launch arguments' },
        environment: { type: 'object', description: 'Environment variables' },
      },
      required: ['udid', 'bundle_id'],
    },
    handler: async (args) => {
      try {
        const pid = await launchApp(
          args.udid as string,
          args.bundle_id as string,
          args.arguments as string[] | undefined,
          args.environment as Record<string, string> | undefined,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, pid }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'LAUNCH_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the app is installed and the simulator is booted.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_terminate_app',
    description: 'Terminate a running app on a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        bundle_id: { type: 'string', description: 'Bundle identifier to terminate' },
      },
      required: ['udid', 'bundle_id'],
    },
    handler: async (args) => {
      try {
        await terminateApp(args.udid as string, args.bundle_id as string);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'TERMINATE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'The app may not be running. Check with xcrun simctl list.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_get_simulator_logs',
    description: 'Get logs from a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        bundle_id: { type: 'string', description: 'Filter by bundle identifier' },
        lines: { type: 'number', description: 'Number of lines to fetch', default: 100 },
        filter: { type: 'string', description: 'Log predicate filter string' },
      },
      required: ['udid'],
    },
    handler: async (args) => {
      try {
        const logs = await getSimulatorLogs(args.udid as string, {
          bundleId: args.bundle_id as string | undefined,
          lines: (args.lines as number) || 100,
          filter: args.filter as string | undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'LOG_FETCH_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator UDID is correct and the simulator exists.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_screenshot_simulator',
    description: 'Take a screenshot of a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        output_path: { type: 'string', description: 'Output path for PNG (optional, uses temp dir)' },
      },
      required: ['udid'],
    },
    handler: async (args) => {
      try {
        const path = await screenshotSimulator(args.udid as string, args.output_path as string | undefined);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, path }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'SCREENSHOT_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator is booted.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_record_simulator',
    description: 'Record video of a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        output_path: { type: 'string', description: 'Output path for .mp4' },
        duration_seconds: { type: 'number', description: 'Recording duration in seconds', default: 10 },
      },
      required: ['udid', 'output_path'],
    },
    handler: async (args) => {
      try {
        const path = await recordSimulator(
          args.udid as string,
          args.output_path as string,
          (args.duration_seconds as number) || 10,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, path }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'RECORD_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator is booted and the output path is writable.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_open_url_simulator',
    description: 'Open a URL on a simulator (for deep link testing)',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        url: { type: 'string', description: 'URL to open (e.g., myapp://deep-link)' },
      },
      required: ['udid', 'url'],
    },
    handler: async (args) => {
      try {
        await openURL(args.udid as string, args.url as string);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'OPEN_URL_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator is booted and the URL scheme is registered.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_set_simulator_location',
    description: 'Set the simulated location for a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        latitude: { type: 'number', description: 'Latitude' },
        longitude: { type: 'number', description: 'Longitude' },
      },
      required: ['udid', 'latitude', 'longitude'],
    },
    handler: async (args) => {
      try {
        await setSimulatorLocation(args.udid as string, args.latitude as number, args.longitude as number);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'LOCATION_SET_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator is booted.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_push_notification_simulator',
    description: 'Simulate a push notification on a simulator',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
        bundle_id: { type: 'string', description: 'Target app bundle identifier' },
        payload: { type: 'object', description: 'Push notification payload (JSON)' },
      },
      required: ['udid', 'bundle_id', 'payload'],
    },
    handler: async (args) => {
      try {
        await pushNotification(args.udid as string, args.bundle_id as string, args.payload as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'PUSH_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator is booted and the app is installed.',
          }) }],
          isError: true,
        };
      }
    },
  });

  server.registerTool({
    name: 'xcode_reset_simulator',
    description: 'Reset a simulator to factory state (erase content and settings)',
    inputSchema: {
      type: 'object',
      properties: {
        udid: { type: 'string', description: 'Simulator UDID' },
      },
      required: ['udid'],
    },
    handler: async (args) => {
      try {
        await resetSimulator(args.udid as string);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, udid: args.udid }) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            code: 'RESET_FAILED',
            message: error instanceof Error ? error.message : String(error),
            suggestion: 'Ensure the simulator exists.',
          }) }],
          isError: true,
        };
      }
    },
  });
}
