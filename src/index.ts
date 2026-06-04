#!/usr/bin/env node

import { XcodeMCPServer } from './server.js';
import { logger, setLogLevel } from './lib/logger.js';

async function main(): Promise<void> {
  const logLevel = process.env.XCODE_MCP_LOG_LEVEL || 'info';
  setLogLevel(logLevel);

  logger.info('Starting xcode-mcp server...');

  const server = new XcodeMCPServer();

  try {
    await server.init();
    await server.start();
  } catch (error) {
    logger.error('Failed to start server:', error);
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      code: 'SERVER_ERROR',
      message,
      suggestion: 'Check your XCODE_PROJECT_PATH and ensure Xcode is installed.',
    }));
    process.exit(1);
  }
}

main();
