const enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

const LOG_LEVELS: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

let currentLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: string): void {
  switch (level) {
    case 'debug': currentLevel = LogLevel.DEBUG; break;
    case 'info': currentLevel = LogLevel.INFO; break;
    case 'warn': currentLevel = LogLevel.WARN; break;
    case 'error': currentLevel = LogLevel.ERROR; break;
    default: currentLevel = LogLevel.INFO;
  }
}

function log(level: LogLevel, ...args: unknown[]): void {
  if (LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [xcode-mcp]`;
    console.error(prefix, ...args);
  }
}

export const logger = {
  debug: (...args: unknown[]) => log(LogLevel.DEBUG, ...args),
  info: (...args: unknown[]) => log(LogLevel.INFO, ...args),
  warn: (...args: unknown[]) => log(LogLevel.WARN, ...args),
  error: (...args: unknown[]) => log(LogLevel.ERROR, ...args),
};
