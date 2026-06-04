param(
    [string]$ProjectPath = "",
    [string]$DefaultScheme = "",
    [switch]$Quiet
)

function Write-Info  { Write-Host "[✓] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[!] $args" -ForegroundColor Yellow }
function Write-Error { Write-Host "[✗] $args" -ForegroundColor Red }
function Write-Step { Write-Host "`n━━━ $args ━━━" -ForegroundColor Cyan }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Step "Checking prerequisites"

try {
    $nodeVer = node --version 2>$null
    if (-not $nodeVer) { throw "not found" }
    $majorVer = [int]($nodeVer -replace 'v', '' -replace '\..*', '')
    Write-Info "Node.js $nodeVer detected"
    if ($majorVer -lt 18) {
        Write-Error "Node.js 18+ required (found: $nodeVer)"
        Write-Host "  Download from: https://nodejs.org/en/download/"
        exit 1
    }
} catch {
    Write-Error "Node.js is required but not installed."
    Write-Host "  Download from: https://nodejs.org/en/download/"
    exit 1
}

try {
    $npmVer = npm --version 2>$null
    Write-Info "npm $npmVer detected"
} catch {
    Write-Error "npm not found."
    exit 1
}

$OSName = (Get-CimInstance Win32_OperatingSystem).Caption
if ($OSName -match "Windows") {
    Write-Warn "Running on Windows — xcode-mcp only works on macOS."
    Write-Host "  The installer will continue, but the server requires"
    Write-Host "  Xcode CLI tools (xcodebuild, xcrun, simctl) which are"
    Write-Host "  only available on macOS."
    Write-Host ""
    Write-Host "  You can still install for development/reference."
}

Write-Step "Installing dependencies"
Set-Location $ScriptDir
npm install --loglevel=warn
Write-Info "Dependencies installed"

Write-Step "Building TypeScript"
npm run build
Write-Info "Build complete"

Write-Step "OpenCode configuration"

$OpenCodeConfig = "$env:USERPROFILE\.config\opencode\opencode.json"
if (-not (Test-Path $OpenCodeConfig)) {
    $OpenCodeConfig = "$env:APPDATA\opencode\opencode.json"
}

if (-not $ProjectPath -and -not $Quiet) {
    Write-Host ""
    $ProjectPath = Read-Host "  Enter Xcode project path (.xcodeproj or .xcworkspace)`n  (leave empty to configure later)"
}

if ($ProjectPath) {
    if ($ProjectPath -match '\.(xcodeproj|xcworkspace)$') {
        $DefaultScheme = [System.IO.Path]::GetFileNameWithoutExtension($ProjectPath)
        Write-Info "Detected scheme: $DefaultScheme"
    } else {
        Write-Warn "Path does not end with .xcodeproj or .xcworkspace"
        $ProjectPath = ""
    }
}

if ($Quiet) {
    Write-Info "Quiet mode — skipping project path prompt"
}

$McpEntry = @{
    type = "local"
    command = @("node", "$ScriptDir/dist/index.js")
    enabled = $true
}
if ($ProjectPath) {
    $McpEntry["environment"] = @{
        XCODE_PROJECT_PATH = $ProjectPath
        XCODE_DEFAULT_SCHEME = $DefaultScheme
    }
}

try {
    $configDir = Split-Path $OpenCodeConfig -Parent
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $config = @{}
    if (Test-Path $OpenCodeConfig) {
        $config = Get-Content $OpenCodeConfig -Raw | ConvertFrom-Json -AsHashtable
    }
    if (-not $config.ContainsKey("mcp")) {
        $config["mcp"] = @{}
    }
    $config["mcp"]["xcode"] = $McpEntry

    $config | ConvertTo-Json -Depth 10 | Set-Content $OpenCodeConfig -Encoding UTF8
    Write-Info "OpenCode config updated at $OpenCodeConfig"
} catch {
    Write-Warn "Could not update OpenCode config: $_"
    Write-Host "  Manually add this entry:"
    Write-Host ($McpEntry | ConvertTo-Json -Depth 10)
}

Write-Step "Verifying build"
$IndexJs = "$ScriptDir/dist/index.js"
if (Test-Path $IndexJs) {
    $Size = (Get-Item $IndexJs).Length
    if ($Size -gt 1MB) {
        Write-Info "Built: $([math]::Round($Size / 1MB, 1)) MB"
    } else {
        Write-Info "Built: $([math]::Round($Size / 1KB, 0)) KB"
    }
} else {
    Write-Error "Build output not found at dist/index.js"
    exit 1
}

Write-Step "Installation complete"
Write-Host ""
Write-Host "  xcode-mcp has been installed at:" -ForegroundColor Cyan
Write-Host "    $ScriptDir"
Write-Host ""
Write-Host "  What's next:" -ForegroundColor Cyan
Write-Host ""
if (-not $ProjectPath) {
    Write-Host "  1. Set XCODE_PROJECT_PATH in your environment:"
    Write-Host "     \$env:XCODE_PROJECT_PATH = 'C:\path\to\YourApp.xcodeproj'"
    Write-Host ""
}
Write-Host "  2. Restart OpenCode (or reload MCP servers)"
Write-Host ""
Write-Host "  3. The xcode tools will appear under /mcp"
Write-Host ""
Write-Host "  Quick start:" -ForegroundColor Cyan
Write-Host "     cd $ScriptDir"
Write-Host "     npm start"
Write-Host ""
Write-Host "  Documentation:" -ForegroundColor Cyan
Write-Host "     README:      $ScriptDir\README.md"
Write-Host "     Tools ref:   $ScriptDir\TOOLS_REFERENCE.md"
Write-Host ""

if ($OSName -match "Windows") {
    Write-Warn "xcode-mcp requires macOS + Xcode to function."
    Write-Host "  The server binary is installed, but its tools"
    Write-Host "  (xcodebuild, xcrun, simctl) only exist on macOS."
}
