var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/lib/logger.ts
var LOG_LEVELS = {
  ["debug" /* DEBUG */]: 0,
  ["info" /* INFO */]: 1,
  ["warn" /* WARN */]: 2,
  ["error" /* ERROR */]: 3
};
var currentLevel = "info" /* INFO */;
function setLogLevel(level) {
  switch (level) {
    case "debug":
      currentLevel = "debug" /* DEBUG */;
      break;
    case "info":
      currentLevel = "info" /* INFO */;
      break;
    case "warn":
      currentLevel = "warn" /* WARN */;
      break;
    case "error":
      currentLevel = "error" /* ERROR */;
      break;
    default:
      currentLevel = "info" /* INFO */;
  }
}
function log(level, ...args) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [xcode-mcp]`;
    console.error(prefix, ...args);
  }
}
var logger = {
  debug: (...args) => log("debug" /* DEBUG */, ...args),
  info: (...args) => log("info" /* INFO */, ...args),
  warn: (...args) => log("warn" /* WARN */, ...args),
  error: (...args) => log("error" /* ERROR */, ...args)
};

export {
  __require,
  setLogLevel,
  logger
};
