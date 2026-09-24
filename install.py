#!/usr/bin/env python3
"""xcode-mcp unified installer — macOS / Windows / Linux, single file, stdlib only.

Does the full install flow:
  1. Checks prerequisites (Node 18+, npm, Xcode tools on macOS).
  2. Installs npm dependencies (unless --no-deps).
  3. Builds TypeScript (unless --no-build).
  4. Registers the `xcode` MCP server with AI clients:
     opencode, cline, kilo, freebuff (Codebuff/Freebuff CLI).
  5. Verifies the build output.

Examples:
  python3 install.py
  python3 install.py --project-path ~/Projects/MyApp.xcodeproj --clients all --yes
  python3 install.py --clients cline,kilo --no-deps --no-build --dry-run
  python3 install.py --clients freebuff --freebuff-global --verbose

Exit codes: 0 ok, 1 runtime error, 2 bad arguments.
Only the standard library is used so it runs on stock macOS/Windows/Linux Python 3.8+.
"""

import argparse
import datetime
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SERVER_NAME = "xcode"
CLIENTS = ("opencode", "cline", "kilo", "freebuff")
MIN_NODE_MAJOR = 18
REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_SERVER_REL = Path("dist") / "index.js"

# ---------------------------------------------------------------------------
# Logging (ANSI colors disabled on dumb terminals / plain Windows consoles)
# ---------------------------------------------------------------------------

_USE_COLOR = (
    sys.stdout.isatty()
    and os.environ.get("TERM", "") != "dumb"
    and os.environ.get("NO_COLOR") is None
)


def _paint(code: str, text: str) -> str:
    if not _USE_COLOR:
        return text
    return f"\033[{code}m{text}\033[0m"


def info(msg: str) -> None:
    print(f"{_paint('32', '[✓]')} {msg}")


def warn(msg: str) -> None:
    print(f"{_paint('33', '[!]')} {msg}")


def error(msg: str) -> None:
    print(f"{_paint('31', '[✗]')} {msg}", file=sys.stderr)


def step(msg: str) -> None:
    print(f"\n{_paint('36', '━━━ ' + msg + ' ━━━')}")


def verbose(msg: str, enabled: bool) -> None:
    if enabled:
        print(f"  [debug] {msg}")


# ---------------------------------------------------------------------------
# OS / path helpers — all edge cases around HOME live here
# ---------------------------------------------------------------------------


def get_home() -> Path:
    """Return a writable home directory or raise with a clear message."""
    try:
        home = Path.home()
        if str(home) and str(home) not in ("~", "."):
            return home
    except Exception:
        pass
    for var in ("HOME", "USERPROFILE"):
        val = os.environ.get(var, "").strip()
        if val:
            candidate = Path(val).expanduser()
            if candidate.is_dir():
                return candidate
    # Windows fallback: HOMEDRIVE + HOMEPATH
    drive = os.environ.get("HOMEDRIVE", "")
    path = os.environ.get("HOMEPATH", "")
    if drive and path and Path(drive + path).is_dir():
        return Path(drive + path)
    raise RuntimeError(
        "Could not determine a home directory (HOME/USERPROFILE unset). "
        "Set HOME (macOS/Linux) or USERPROFILE (Windows) and retry."
    )


def expand_path(raw: str, home: Path) -> str:
    """Expand ~, env vars and relative paths to an absolute path string."""
    if raw is None:
        return ""
    text = os.path.expandvars(raw.strip().strip('"').strip("'"))
    if not text:
        return ""
    if text == "~":
        return str(home)
    if text.startswith("~/") or text.startswith("~\\"):
        return str(home / text[2:])
    path = Path(text)
    if not path.is_absolute():
        path = Path.cwd() / path
    return os.path.normpath(str(path))


def system() -> str:
    return platform.system()  # Darwin | Windows | Linux | ...


def is_windows() -> bool:
    return system() == "Windows" or os.name == "nt"


# ---------------------------------------------------------------------------
# JSON / JSONC helpers
# ---------------------------------------------------------------------------

_JSONC_BLOCK_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def strip_jsonc_comments(raw: str) -> str:
    """Remove /* */ and // comments without touching string contents."""
    no_blocks = _JSONC_BLOCK_RE.sub("", raw)
    out_lines = []
    for line in no_blocks.splitlines():
        buf: list = []
        in_str = False
        esc = False
        i = 0
        while i < len(line):
            ch = line[i]
            if in_str:
                buf.append(ch)
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                i += 1
                continue
            if ch == '"':
                in_str = True
                buf.append(ch)
                i += 1
                continue
            if ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
                break  # rest of line is a comment
            buf.append(ch)
            i += 1
        out_lines.append("".join(buf))
    return "\n".join(out_lines)


def read_jsonc(path: Path) -> tuple:
    """Return (data: dict, existed: bool). Corrupt files -> ({}, True) + backup."""
    if not path.exists():
        return {}, False
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except PermissionError:
        raise
    except OSError as exc:
        warn(f"Could not read {path}: {exc} — starting from empty object.")
        return {}, True
    if not raw.strip():
        return {}, True
    try:
        data = json.loads(strip_jsonc_comments(raw))
    except (json.JSONDecodeError, ValueError) as exc:
        backup = backup_path(path)
        try:
            shutil.copy2(path, backup)
            warn(f"Invalid JSON in {path} ({exc}); backed up to {backup}, starting fresh.")
        except OSError:
            warn(f"Invalid JSON in {path} ({exc}); backup failed, starting fresh.")
        return {}, True
    if not isinstance(data, dict):
        warn(f"Ignoring {path}: top level is not a JSON object — starting fresh.")
        return {}, True
    return data, True


def backup_path(path: Path) -> Path:
    # Microsecond stamp + collision counter: two runs in the same second
    # (or same microsecond on coarse clocks) must never clobber each other.
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    candidate = path.with_name(path.name + f".bak.{stamp}")
    counter = 0
    while candidate.exists():
        counter += 1
        candidate = path.with_name(path.name + f".bak.{stamp}.{counter}")
    return candidate


def atomic_write_json(path: Path, data: dict, dry_run: bool, verbose_on: bool) -> bool:
    """Write JSON atomically (tmp + replace) with timestamped backup. Returns changed."""
    if dry_run:
        print(f"[dry-run] would write {path}:\n{json.dumps(data, indent=2)}\n")
        return True
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        error(f"No permission to create directory {path.parent}. Skipping {path}.")
        raise
    except OSError as exc:
        error(f"Cannot create directory {path.parent}: {exc}")
        raise
    if path.exists():
        try:
            backup = backup_path(path)
            shutil.copy2(path, backup)
            verbose(f"Backed up {path} -> {backup}", verbose_on)
        except OSError as exc:
            warn(f"Could not back up {path}: {exc} — continuing anyway.")
    tmp = None
    try:
        fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
        )
        tmp = Path(tmp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
        info(f"Updated {path}")
        return True
    except PermissionError:
        error(f"No permission to write {path}.")
        raise
    except OSError as exc:
        # ENOSPC (28) etc.
        error(f"Failed to write {path}: {exc}")
        raise
    finally:
        if tmp is not None and tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

_PROJECT_EXTS = (".xcodeproj", ".xcworkspace")


def validate_project_path(raw: str, home: Path, strict: bool = False) -> str:
    """Normalize a project path; resolve bare dirs containing a bundle. Warns, rarely fails."""
    if raw is None or not str(raw).strip():
        return ""
    text = str(raw).strip()
    if len(text) > 4096:
        raise ValueError("Project path exceeds 4096 characters.")
    if "\0" in text:
        raise ValueError("Project path must not contain null bytes.")
    expanded = expand_path(text, home)
    if len(expanded) > 4096:
        raise ValueError("Expanded project path is too long.")
    candidate = Path(expanded)
    if candidate.is_dir() and candidate.suffix.lower() not in _PROJECT_EXTS:
        try:
            children = sorted(
                p for p in candidate.iterdir() if p.suffix.lower() in _PROJECT_EXTS
            )
        except OSError:
            children = []
        if len(children) == 1:
            resolved = str(children[0])
            warn(f"Resolved project directory to {resolved}")
            return resolved
        if len(children) > 1:
            names = ", ".join(p.name for p in children)
            raise ValueError(
                f"Directory {candidate} contains multiple projects ({names}). "
                "Pass the .xcodeproj/.xcworkspace directly."
            )
    lowered = expanded.lower()
    if not lowered.endswith(_PROJECT_EXTS):
        msg = f"Path does not end with .xcodeproj or .xcworkspace: {expanded}"
        if strict:
            raise ValueError(msg)
        warn(msg + " — continuing anyway.")
    if not candidate.exists():
        msg = f"Project path does not exist: {expanded}"
        if strict:
            raise ValueError(msg)
        warn(msg + " — writing config anyway.")
    return expanded


def validate_scheme(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    if len(text) > 256:
        raise ValueError("Scheme exceeds 256 characters.")
    if not re.fullmatch(r"[\w\s\-_().+]+", text):
        raise ValueError(
            f"Scheme {text!r} contains invalid characters "
            "(allowed: letters, numbers, space, - _ ( ) . +)."
        )
    return text


def guess_scheme(project_path: str) -> str:
    if not project_path:
        return ""
    base = os.path.basename(project_path.rstrip("/\\"))
    lowered = base.lower()
    for ext in _PROJECT_EXTS:
        if lowered.endswith(ext):
            return base[: -len(ext)]
    return ""


def parse_clients(raw_list) -> list:
    seen: list = []
    for raw in raw_list or []:
        for part in str(raw).split(","):
            name = part.strip().lower()
            if name and name not in seen:
                seen.append(name)
    if "all" in seen:
        return list(CLIENTS)
    unknown = [c for c in seen if c not in CLIENTS]
    if unknown:
        raise ValueError(
            f"Unknown client(s): {', '.join(unknown)}. Valid: {', '.join(CLIENTS)}, all"
        )
    return seen or list(CLIENTS)


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------


def run_cmd(
    argv: list,
    timeout: int,
    cwd=None,
    verbose_on: bool = False,
    check: bool = False,
):
    """Run argv without a shell; always captures output; handles missing binaries."""
    verbose(f"$ {' '.join(argv)} (timeout={timeout}s)", verbose_on)
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            text=True,
            errors="replace",
            shell=False,
        )
    except FileNotFoundError:
        return None, f"command not found: {argv[0]}", -1, True
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        return out, f"timed out after {timeout}s", 124, True
    except OSError as exc:
        return "", str(exc), -1, True
    output = completed.stdout or ""
    if check and completed.returncode != 0:
        return output, output[-4000:], completed.returncode, False
    return output, "", completed.returncode, completed.returncode == 0


def node_major_version(verbose_on: bool) -> int | None:
    out, _, code, ok = run_cmd(["node", "--version"], timeout=15, verbose_on=verbose_on)
    if not ok:
        return None
    match = re.search(r"v?(\d+)", (out or "").strip())
    return int(match.group(1)) if match else None


# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------


def check_prerequisites(verbose_on: bool) -> dict:
    """Check node/npm/Xcode; returns {'node': ..., 'npm': ..., 'xcode': ...}."""
    step("Checking prerequisites")
    if sys.version_info < (3, 8):
        error(f"Python 3.8+ required (found {platform.python_version()}).")
        sys.exit(1)

    node_out, _, _, node_ok = run_cmd(
        ["node", "--version"], timeout=15, verbose_on=verbose_on
    )
    if not node_ok:
        error("Node.js is required but not installed.")
        print("  Install from https://nodejs.org/en/download/ (v18 or later)")
        sys.exit(1)
    major = node_major_version(verbose_on)
    info(f"Node.js {(node_out or '').strip()} detected")
    if major is None or major < MIN_NODE_MAJOR:
        error(f"Node.js 18+ required (found {(node_out or '').strip() or 'unknown'}).")
        sys.exit(1)

    npm_out, _, _, npm_ok = run_cmd(
        ["npm", "--version"], timeout=15, verbose_on=verbose_on
    )
    if not npm_ok:
        error("npm not found (it ships with Node.js — reinstall Node).")
        sys.exit(1)
    info(f"npm {(npm_out or '').strip()} detected")

    plat = system()
    xcode_state = "unknown"
    if plat == "Darwin":
        _, _, code, ok = run_cmd(
            ["xcode-select", "-p"], timeout=15, verbose_on=verbose_on
        )
        if ok:
            info("Xcode CLI tools detected")
            xcode_state = "ok"
            out, _, _, build_ok = run_cmd(
                ["xcodebuild", "-version"], timeout=30, verbose_on=verbose_on
            )
            if build_ok:
                first = (out or "").strip().splitlines()
                if first:
                    verbose(f"xcodebuild: {first[0]}", verbose_on)
            else:
                warn("xcodebuild not functional (full Xcode may be missing).")
                warn("  Some tools require Xcode 14+. Continuing anyway.")
                xcode_state = "partial"
        else:
            warn("Xcode CLI tools not found (xcode-select -p failed).")
            print("  Install: xcode-select --install (some tools need full Xcode).")
            xcode_state = "missing"
    else:
        warn(f"Running on {plat} — xcode-mcp only works on macOS.")
        print("  The installer continues, but xcodebuild/simctl require Xcode/macOS.")
        xcode_state = "non-mac"
    try:
        free = shutil.disk_usage(str(REPO_ROOT)).free
        if free < 500 * 1024 * 1024:
            warn(f"Low disk space ({free // 1024 // 1024} MB free). Build may fail.")
    except OSError:
        pass
    return {"node": (node_out or "").strip(), "npm": (npm_out or "").strip(), "xcode": xcode_state}


def npm_install(skip: bool, verbose_on: bool) -> None:
    step("Installing dependencies")
    if skip:
        warn("Skipping npm install (--no-deps).")
        return
    out, err, code, ok = run_cmd(
        ["npm", "install", "--loglevel=warn"], timeout=600,
        cwd=REPO_ROOT, verbose_on=verbose_on,
    )
    tail = (out or "")[-2000:]
    if not ok:
        error(f"npm install failed (exit {code}).")
        if tail.strip():
            print(tail)
        if err:
            print(err[-2000:])
        sys.exit(1)
    info("Dependencies installed")
    if verbose_on and tail.strip():
        print(tail)


def npm_build(skip: bool, verbose_on: bool) -> None:
    step("Building TypeScript")
    if skip:
        warn("Skipping build (--no-build).")
        return
    out, err, code, ok = run_cmd(
        ["npm", "run", "build"], timeout=300, cwd=REPO_ROOT, verbose_on=verbose_on
    )
    if not ok:
        error(f"npm run build failed (exit {code}).")
        print((out or "")[-4000:])
        if err:
            print(err[-2000:])
        sys.exit(1)
    info("Build complete")


# ---------------------------------------------------------------------------
# Client config paths (per OS)
# ---------------------------------------------------------------------------


def _appdata(home: Path) -> Path | None:
    val = os.environ.get("APPDATA", "").strip()
    if val and Path(val).is_dir():
        return Path(val)
    return None


def opencode_target(home: Path) -> Path:
    base = home / ".config" / "opencode"
    jsonc = base / "opencode.jsonc"
    js = base / "opencode.json"
    # Prefer the file the user already uses; default to opencode.json.
    try:
        if jsonc.exists() and not js.exists():
            return jsonc
    except OSError:
        pass
    if is_windows():
        appdata = _appdata(home)
        if appdata and not js.exists() and (appdata / "opencode" / "opencode.json").exists():
            return appdata / "opencode" / "opencode.json"
    return js


def cline_primary(home: Path) -> Path:
    return home / ".cline" / "data" / "settings" / "cline_mcp_settings.json"


def cline_legacy_paths(home: Path) -> list:
    if system() == "Darwin":
        return [home / "Library" / "Application Support" / "Code" / "User"
                / "globalStorage" / "saoudrizwan.claude-dev" / "settings"
                / "cline_mcp_settings.json"]
    if is_windows():
        appdata = _appdata(home) or (home / "AppData" / "Roaming")
        return [appdata / "Code" / "User" / "globalStorage"
                / "saoudrizwan.claude-dev" / "settings" / "cline_mcp_settings.json"]
    return [home / ".config" / "Code" / "User" / "globalStorage"
            / "saoudrizwan.claude-dev" / "settings" / "cline_mcp_settings.json"]


def kilo_global(home: Path) -> Path:
    return home / ".config" / "kilo" / "kilo.jsonc"


def kilo_legacy_paths(home: Path) -> list:
    if system() == "Darwin":
        return [home / "Library" / "Application Support" / "Code" / "User"
                / "globalStorage" / "kilo-code.kilo-code" / "settings"
                / "mcp_settings.json"]
    if is_windows():
        appdata = _appdata(home) or (home / "AppData" / "Roaming")
        return [appdata / "Code" / "User" / "globalStorage"
                / "kilo-code.kilo-code" / "settings" / "mcp_settings.json"]
    return [home / ".config" / "Code" / "User" / "globalStorage"
            / "kilo-code.kilo-code" / "settings" / "mcp_settings.json"]


# ---------------------------------------------------------------------------
# Client registrars — each returns list of touched paths
# ---------------------------------------------------------------------------


def _env_block(project_path: str, scheme: str) -> dict:
    env: dict = {}
    if project_path:
        env["XCODE_PROJECT_PATH"] = project_path
    if scheme:
        env["XCODE_DEFAULT_SCHEME"] = scheme
    return env


def _stdio_entry(server_path: str, project_path: str, scheme: str) -> dict:
    return {"command": "node", "args": [server_path], "env": _env_block(project_path, scheme)}


def _as_obj(mapping: dict, key: str) -> dict:
    value = mapping.get(key)
    if not isinstance(value, dict):
        if value is not None:
            warn(f"Ignoring non-object '{key}' in existing config — resetting it.")
        value = {}
        mapping[key] = value
    return value


def register_opencode(server_path, project_path, scheme, *, dry_run, verbose_on, home) -> list:
    target = opencode_target(home)
    config, _ = read_jsonc(target)
    config["mcp"] = _as_obj(config, "mcp")
    entry = {"type": "local", "command": ["node", server_path], "enabled": True}
    env = _env_block(project_path, scheme)
    if env:
        entry["environment"] = env
    config["mcp"][SERVER_NAME] = entry
    # v2 mirror: mcp.servers.<name> (v2 uses `disabled`, not `enabled`)
    servers = _as_obj(config["mcp"], "servers")
    v2_entry = dict(entry)
    v2_entry.pop("enabled", None)
    servers[SERVER_NAME] = v2_entry
    atomic_write_json(target, config, dry_run, verbose_on)
    return [str(target)]


def register_cline(server_path, project_path, scheme, *, dry_run, verbose_on, home) -> list:
    touched = []
    primary = cline_primary(home)
    config, _ = read_jsonc(primary)
    servers = _as_obj(config, "mcpServers")
    entry = _stdio_entry(server_path, project_path, scheme)
    entry["disabled"] = False
    servers[SERVER_NAME] = entry
    atomic_write_json(primary, config, dry_run, verbose_on)
    touched.append(str(primary))
    for legacy in cline_legacy_paths(home):
        try:
            if legacy.exists():
                legacy_cfg, _ = read_jsonc(legacy)
                legacy_servers = _as_obj(legacy_cfg, "mcpServers")
                legacy_servers[SERVER_NAME] = dict(entry)
                atomic_write_json(legacy, legacy_cfg, dry_run, verbose_on)
                touched.append(str(legacy))
        except OSError as exc:
            warn(f"Skipping legacy Cline path {legacy}: {exc}")
    return touched


def register_kilo(server_path, project_path, scheme, *, dry_run, verbose_on, home) -> list:
    touched = []
    global_path = kilo_global(home)
    config, _ = read_jsonc(global_path)
    mcp = _as_obj(config, "mcp")
    entry = {"type": "local", "command": ["node", server_path],
             "enabled": True, "timeout": 10000}
    env = _env_block(project_path, scheme)
    if env:
        entry["environment"] = env
    mcp[SERVER_NAME] = entry
    atomic_write_json(global_path, config, dry_run, verbose_on)
    touched.append(str(global_path))
    for legacy in kilo_legacy_paths(home):
        try:
            if legacy.exists():
                legacy_cfg, _ = read_jsonc(legacy)
                legacy_servers = _as_obj(legacy_cfg, "mcpServers")
                stdio = _stdio_entry(server_path, project_path, scheme)
                stdio["disabled"] = False
                legacy_servers[SERVER_NAME] = stdio
                atomic_write_json(legacy, legacy_cfg, dry_run, verbose_on)
                touched.append(str(legacy))
        except OSError as exc:
            warn(f"Skipping legacy Kilo path {legacy}: {exc}")
    return touched


def register_freebuff(server_path, project_path, scheme, *, dry_run, verbose_on,
                       home, repo_root, global_also: bool) -> list:
    touched = []
    if project_path:
        lowered = project_path.lower()
        if lowered.endswith((".xcodeproj", ".xcworkspace")):
            project_dir = str(Path(project_path).parent)
        else:
            project_dir = project_path
    else:
        project_dir = str(repo_root)
    local_path = Path(project_dir) / ".agents" / "mcp.json"
    entry = _stdio_entry(server_path, project_path, scheme)
    targets = [local_path]
    home_agents = home / ".agents" / "mcp.json"
    if global_also and home_agents != local_path:
        targets.append(home_agents)
    for path in targets:
        try:
            cfg, _ = read_jsonc(path)
            servers = _as_obj(cfg, "mcpServers")
            servers[SERVER_NAME] = dict(entry)
            atomic_write_json(path, cfg, dry_run, verbose_on)
            touched.append(str(path))
        except OSError as exc:
            warn(f"Skipping Freebuff path {path}: {exc}")
    # de-dupe while preserving order
    seen: list = []
    for item in touched:
        if item not in seen:
            seen.append(item)
    return seen


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_build(server_path: Path, verbose_on: bool) -> bool:
    step("Verifying build")
    if not server_path.exists():
        error(f"Build output not found at {server_path}")
        print("  Try: python3 install.py (without --no-build) or npm run build")
        return False
    try:
        size = server_path.stat().st_size
    except OSError as exc:
        error(f"Cannot stat {server_path}: {exc}")
        return False
    if size == 0:
        error(f"Build output is empty: {server_path}")
        return False
    if size > 1024 * 1024:
        info(f"Built: {size / 1024 / 1024:.1f} MB")
    else:
        info(f"Built: {max(1, size // 1024)} KB")
    out, _, _, ok = run_cmd(["node", "--check", str(server_path)],
                            timeout=30, verbose_on=verbose_on)
    if not ok:
        error(f"node --check failed for {server_path}")
        if out:
            print(out[-2000:])
        return False
    # Smoke test: server must start on stdio (it exits 1 without a project path —
    # that still proves the bundle loads; with a bogus path it prints an error).
    try:
        proc = subprocess.Popen(
            ["node", str(server_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
        )
        try:
            _, stderr = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            _, stderr = proc.communicate(timeout=5)
            verbose("Server stayed alive past 5s on stdio (expected for MCP servers).",
                    verbose_on)
            info("Server starts successfully (stdio alive after 5s)")
            return True
        if proc.returncode == 0 or "xcode-mcp" in (stderr or "").lower():
            info("Server starts successfully")
            return True
        warn("Server exited during smoke test; bundle parses but check XCODE_PROJECT_PATH.")
        if verbose_on and stderr:
            print(stderr[-2000:])
        return True  # bundle is valid; config-dependent exit is not fatal
    except FileNotFoundError:
        error("node disappeared between checks.")
        return False
    except OSError as exc:
        error(f"Smoke test failed: {exc}")
        return False


# ---------------------------------------------------------------------------
# Interactive prompting (TTY-aware)
# ---------------------------------------------------------------------------


def ask(prompt_text: str, default: str = "", non_interactive: bool = False) -> str:
    if non_interactive or not sys.stdin.isatty():
        return default
    try:
        suffix = f" [{default}]" if default else ""
        answer = input(f"  {prompt_text}{suffix}: ").strip()
        return answer if answer else default
    except (EOFError, KeyboardInterrupt):
        print()
        return default


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="install.py",
        description="Install xcode-mcp and register it with AI clients "
                    "(opencode, cline, kilo, freebuff) on macOS, Windows and Linux.",
    )
    parser.add_argument("--project-path", default=os.environ.get("XCODE_PROJECT_PATH", ""),
                        help="Path to .xcodeproj/.xcworkspace (or $XCODE_PROJECT_PATH).")
    parser.add_argument("--scheme", default=os.environ.get("XCODE_DEFAULT_SCHEME", ""),
                        help="Default scheme (or $XCODE_DEFAULT_SCHEME; guessed from bundle name).")
    parser.add_argument("--clients", "--client", dest="clients", action="append", default=[],
                        help="Comma-separated list from opencode,cline,kilo,freebuff,all. "
                             "Repeatable. Default: all.")
    parser.add_argument("--server-path", default="",
                        help="Custom server entrypoint (default: <repo>/dist/index.js).")
    parser.add_argument("--freebuff-global", action="store_true",
                        help="Also write ~/.agents/mcp.json for Freebuff.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would change without writing files or running npm.")
    parser.add_argument("--no-deps", action="store_true", help="Skip npm install.")
    parser.add_argument("--no-build", action="store_true", help="Skip npm run build.")
    parser.add_argument("--strict", action="store_true",
                        help="Fail on bad project path instead of warning.")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Assume yes for prompts (non-interactive overwrite).")
    parser.add_argument("--non-interactive", action="store_true",
                        help="Never prompt; use flags/env/defaults.")
    parser.add_argument("--quiet", "-q", action="store_true", help="Minimal output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug output.")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)

    verbose_on = bool(args.verbose) and not bool(args.quiet)
    dry_run: bool = args.dry_run
    auto_yes: bool = args.yes or args.non_interactive or args.quiet

    try:
        home = get_home()
    except RuntimeError as exc:
        error(str(exc))
        return 1

    # --- clients -----------------------------------------------------------
    try:
        clients = parse_clients(args.clients)
    except ValueError as exc:
        error(str(exc))
        return 2

    # --- server path -------------------------------------------------------
    server_raw = args.server_path.strip() or str(REPO_ROOT / DEFAULT_SERVER_REL)
    server_path = Path(expand_path(server_raw, home))

    # --- prerequisites / install / build -----------------------------------
    if not dry_run:
        try:
            check_prerequisites(verbose_on)
        except SystemExit as exc:
            return int(exc.code or 1)
        npm_install(bool(args.no_deps), verbose_on)
        npm_build(bool(args.no_build), verbose_on)
    else:
        print("(dry-run: skipping prerequisite checks, npm install and build)")

    # --- project path / scheme (prompt only when interactive) --------------
    interactive = sys.stdin.isatty() and not args.non_interactive and not args.quiet
    project_input = (args.project_path or "").strip()
    if not project_input and interactive:
        print("\n  Enter the path to your Xcode project (.xcodeproj or .xcworkspace)")
        print("  Leave empty to configure via XCODE_PROJECT_PATH later.\n")
        project_input = ask("Project path", "")

    try:
        project_path = validate_project_path(project_input, home, strict=bool(args.strict))
    except ValueError as exc:
        error(str(exc))
        return 2

    scheme = ""
    try:
        scheme = validate_scheme(args.scheme)
    except ValueError as exc:
        error(str(exc))
        return 2
    if project_path and not scheme:
        scheme = guess_scheme(project_path)
        if scheme and not args.quiet:
            print(f"  Detected scheme: {scheme}")

    if interactive and not project_path:
        warn("No project path — configs will omit XCODE_PROJECT_PATH.")

    # --- client selection prompt (only when user gave nothing) -------------
    if not args.clients and interactive:
        print("\n  Supported clients: opencode, cline, kilo, freebuff")
        answer = ask("Clients (comma-separated) [all]", "all")
        if answer:
            try:
                clients = parse_clients([answer])
            except ValueError as exc:
                error(str(exc))
                return 2

    if not dry_run and not server_path.exists():
        warn(f"Server not found at {server_path} — did the build succeed? "
             "Writing configs anyway.")

    step("AI client configuration")
    print(f"  server:  {server_path}")
    if project_path:
        print(f"  project: {project_path}")
    if scheme:
        print(f"  scheme:  {scheme}")
    print(f"  clients: {', '.join(clients)}")
    if dry_run:
        print("  (dry-run: no files will be written)")

    registrars = {
        "opencode": lambda: register_opencode(
            str(server_path), project_path, scheme,
            dry_run=dry_run, verbose_on=verbose_on, home=home),
        "cline": lambda: register_cline(
            str(server_path), project_path, scheme,
            dry_run=dry_run, verbose_on=verbose_on, home=home),
        "kilo": lambda: register_kilo(
            str(server_path), project_path, scheme,
            dry_run=dry_run, verbose_on=verbose_on, home=home),
        "freebuff": lambda: register_freebuff(
            str(server_path), project_path, scheme,
            dry_run=dry_run, verbose_on=verbose_on, home=home,
            repo_root=REPO_ROOT, global_also=bool(args.freebuff_global)),
    }

    failures: list = []
    for client in clients:
        try:
            registrars[client]()
        except PermissionError as exc:
            error(f"{client}: permission denied — {exc}")
            failures.append(client)
        except OSError as exc:
            error(f"{client}: {exc}")
            failures.append(client)
        except (ValueError, RuntimeError) as exc:
            error(f"{client}: {exc}")
            failures.append(client)
    _ = auto_yes  # overwrite is always backup-safe; flag kept for CI parity

    if failures:
        error(f"Client setup failed for: {', '.join(failures)}")
        print("  Re-run later, e.g.:")
        print(f"    python3 install.py --clients {','.join(failures)} --no-deps --no-build")
        return 1
    if not args.quiet:
        info(f"AI client(s) configured: {', '.join(clients)}")

    if not dry_run:
        ok = verify_build(server_path, verbose_on)
        skipped_clients = " (verify-only failure; configs were written)" if not ok else ""
    else:
        ok = True
        skipped_clients = ""
        print("\nDry-run complete. Re-run without --dry-run to write files.")

    step("Installation complete")
    print(f"\n  xcode-mcp lives at:\n    {REPO_ROOT}\n")
    print("  What's next:\n")
    if not project_path:
        print("  1. Set XCODE_PROJECT_PATH in your environment:")
        if is_windows():
            print("     $env:XCODE_PROJECT_PATH = 'C:\\path\\to\\YourApp.xcodeproj'\n")
        else:
            print("     export XCODE_PROJECT_PATH=/path/to/YourApp.xcodeproj\n")
    print(f"  {'2.' if not project_path else '1.'} Restart your AI client(s) "
          f"({', '.join(clients)}) so they pick up the new MCP server{skipped_clients}")
    print("  3. The xcode tools appear as MCP tools (e.g. xcode_build)\n")
    print("  Quick start:")
    print(f"     cd {REPO_ROOT}")
    print("     npm start\n")
    print("  Useful links:")
    print(f"     README:    {REPO_ROOT / 'README.md'}")
    print(f"     Tools ref: {REPO_ROOT / 'TOOLS_REFERENCE.md'}\n")
    if system() != "Darwin":
        warn("Note: xcode-mcp requires macOS + Xcode to function.")
        print("  The server is installed, but xcodebuild/xcrun/simctl only exist on macOS.")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted by user.", file=sys.stderr)
        sys.exit(130)
    except BrokenPipeError:
        sys.exit(1)
