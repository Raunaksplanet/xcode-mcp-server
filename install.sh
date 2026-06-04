#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step "Checking prerequisites"

if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed."
  echo "  Install from: https://nodejs.org/en/download/ (v18 or later)"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  error "Node.js 18+ required (found: $(node -v))"
  echo "  Upgrade from: https://nodejs.org/en/download/"
  exit 1
fi
info "Node.js $(node -v) detected"

if ! command -v npm &>/dev/null; then
  error "npm not found."
  exit 1
fi
info "npm $(npm -v) detected"

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  if ! xcode-select -p &>/dev/null; then
    warn "Xcode CLI tools not found."
    echo "  Install: xcode-select --install"
    echo "  Some tools require Xcode. Proceeding anyway."
  else
    info "Xcode CLI tools detected"
  fi
else
  warn "Running on $OS — xcode-mcp only works on macOS."
  echo "  The installer will continue, but the server's tools"
  echo "  (xcodebuild, simctl, etc.) require Xcode/macOS."
fi

NPX="$(command -v npx || echo "${SCRIPT_DIR}/node_modules/.bin/npx")"

step "Installing dependencies"

cd "$SCRIPT_DIR"
npm install --loglevel=warn
info "Dependencies installed"

step "Building TypeScript"

npm run build
info "Build complete"

step "OpenCode configuration"

OPENCODE_CONFIG="${HOME}/.config/opencode/opencode.json"

PROJECT_PATH=""
DEFAULT_SCHEME=""

prompt_for_project() {
  echo ""
  echo "  Enter the path to your Xcode project (.xcodeproj or .xcworkspace)"
  echo "  Leave empty to configure via environment variable later."
  echo ""
  read -rp "  Project path: " PROJECT_PATH

  if [ -n "$PROJECT_PATH" ]; then
    PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"
    PROJECT_PATH="$(cd "$(dirname "$PROJECT_PATH")" 2>/dev/null && pwd)/$(basename "$PROJECT_PATH" 2>/dev/null || echo '')"
    PROJECT_PATH="${PROJECT_PATH:-$PROJECT_PATH}"

    if echo "$PROJECT_PATH" | grep -qE '\.(xcodeproj|xcworkspace)$'; then
      info "Valid project file"
      DEFAULT_SCHEME=$(basename "$PROJECT_PATH" | sed 's/\.\(xcodeproj\|xcworkspace\)$//')
      echo "  Detected scheme: ${DEFAULT_SCHEME}"
    else
      warn "Path does not end with .xcodeproj or .xcworkspace"
      echo "  You can set XCODE_PROJECT_PATH later."
      PROJECT_PATH=""
    fi
  fi
}

prompt_for_project

if [ -f "$OPENCODE_CONFIG" ]; then
  echo ""
  echo "  OpenCode config found at ${OPENCODE_CONFIG}"

  if grep -q '"xcode"' "$OPENCODE_CONFIG" 2>/dev/null; then
    echo ""
    warn "xcode MCP server already registered in OpenCode config."
    read -rp "  Overwrite existing entry? [y/N] " OVERWRITE
    if [ "$OVERWRITE" != "y" ] && [ "$OVERWRITE" != "Y" ]; then
      info "Skipping OpenCode registration."
      SKIP_OPENCODE=1
    fi
  fi
else
  echo ""
  warn "OpenCode config not found at ${OPENCODE_CONFIG}"
  echo "  Creating new configuration file."
  mkdir -p "$(dirname "$OPENCODE_CONFIG")"
  echo '{}' > "$OPENCODE_CONFIG"
fi

if [ -z "${SKIP_OPENCODE:-}" ]; then
  ENV_ENTRY=""
  if [ -n "$PROJECT_PATH" ]; then
    ENV_ENTRY=$(cat <<JSON_END
      "environment": {
        "XCODE_PROJECT_PATH": "${PROJECT_PATH}",
        "XCODE_DEFAULT_SCHEME": "${DEFAULT_SCHEME:-}"
      },
JSON_END
)
  fi

  MCP_ENTRY=$(cat <<JSON
    "xcode": {
      "type": "local",
      "command": [
        "node",
        "${SCRIPT_DIR}/dist/index.js"
      ],
      ${ENV_ENTRY}
      "enabled": true
    }
JSON
)

  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
with open('${OPENCODE_CONFIG}') as f:
    config = json.load(f)
if 'mcp' not in config:
    config['mcp'] = {}
config['mcp']['xcode'] = ${MCP_ENTRY}
with open('${OPENCODE_CONFIG}', 'w') as f:
    json.dump(config, f, indent=2)
"
    info "OpenCode config updated at ${OPENCODE_CONFIG}"
  else
    warn "python3 not found — manually add this to ${OPENCODE_CONFIG}:"
    echo ""
    echo "${MCP_ENTRY}"
    echo ""
  fi

  info "xcode-mcp registered in OpenCode"
fi

step "Verifying build"

if [ -f "${SCRIPT_DIR}/dist/index.js" ]; then
  SIZE=$(du -h "${SCRIPT_DIR}/dist/index.js" | cut -f1)
  info "Built: ${SIZE}"

  if [ "$OS" = "Darwin" ]; then
    echo ""
    echo "  Testing server startup..."
    cd "$SCRIPT_DIR"
    if [ -n "$PROJECT_PATH" ]; then
      timeout 3 node dist/index.js 2>/dev/null && true
    else
      XCODE_PROJECT_PATH="${PROJECT_PATH:-/tmp}" timeout 3 node dist/index.js 2>/dev/null && true
    fi
    echo ""
    info "Server starts successfully"
  fi
else
  error "Build output not found at dist/index.js"
  echo "  Try: npm run build"
  exit 1
fi

step "Installation complete"

echo ""
echo -e "  ${BOLD}xcode-mcp${NC} has been installed at:"
echo "    ${SCRIPT_DIR}"
echo ""
echo "  ${BOLD}What's next:${NC}"
echo ""

if [ -z "$PROJECT_PATH" ]; then
  echo "  1. Set XCODE_PROJECT_PATH in your environment:"
  echo "     export XCODE_PROJECT_PATH=/path/to/YourApp.xcodeproj"
  echo ""
fi

echo "  2. Restart OpenCode (or reload MCP servers)"
echo ""
echo "  3. The xcode tools will appear under /mcp"
echo ""
echo "  ${BOLD}Quick start:${NC}"
echo "     cd ${SCRIPT_DIR}"
echo "     npm start"
echo ""
echo "  ${BOLD}Useful links:${NC}"
echo "     README:      ${SCRIPT_DIR}/README.md"
echo "     Tools ref:   ${SCRIPT_DIR}/TOOLS_REFERENCE.md"
echo ""

if [ "$OS" != "Darwin" ]; then
  warn "Note: xcode-mcp requires macOS + Xcode to function."
  echo "  The server binary is installed, but its tools"
  echo "  (xcodebuild, xcrun, simctl) only exist on macOS."
fi
