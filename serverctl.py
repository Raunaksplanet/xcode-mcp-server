#!/usr/bin/env python3
"""serverctl.py — control the xcode-mcp server on macOS, Windows and Linux.

Single file, standard library only (Python 3.8+).

Commands:
  start    Launch the server as a background daemon (refuses if already running).
  stop     Stop the daemon gracefully (SIGTERM, then SIGKILL after --timeout).
  restart  Stop (tolerating a stopped server) then start.
  status   Show whether the daemon is running (exit 0) or not (exit 1).
  logs     Print log lines, optionally follow like `tail -f`.
  run      Run the server in the foreground (debugging; Ctrl+C to stop).

State lives under <base>/run/xcode-mcp.pid and <base>/logs/xcode-mcp.log where
<base> is --base-dir, $XCODE_MCP_HOME, or ~/.xcode-mcp (in that priority).

Examples:
  python3 serverctl.py start --project-path ~/Projects/MyApp.xcodeproj
  python3 serverctl.py status --json
  python3 serverctl.py logs --lines 50 --follow
  python3 serverctl.py restart --scheme MyApp
  python3 serverctl.py stop --force

Exit codes: 0 ok, 1 runtime/not-running error, 2 bad arguments.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_SERVER_REL = Path("dist") / "index.js"
PID_NAME = "xcode-mcp.pid"
LOG_NAME = "xcode-mcp.log"
START_GRACE_S = 3.0          # how long to watch a new daemon for early crashes
STOP_GRACE_S = 10.0          # SIGTERM grace before SIGKILL
KILL_GRACE_S = 3.0           # wait after SIGKILL before giving up
DEFAULT_MAX_LOG_MB = 20
FOLLOW_INTERVAL_S = 0.25

_TERMINATE_SIG = signal.SIGTERM
_KILL_SIG = getattr(signal, "SIGKILL", signal.SIGTERM)  # Windows has no SIGKILL

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

_USE_COLOR = (
    sys.stdout.isatty()
    and os.environ.get("TERM", "") != "dumb"
    and os.environ.get("NO_COLOR") is None
)


def _paint(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


def info(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(f"{_paint('32', '[✓]')} {msg}")


def warn(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(f"{_paint('33', '[!]')} {msg}")


def error(msg: str) -> None:
    print(f"{_paint('31', '[✗]')} {msg}", file=sys.stderr)


def step(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(f"\n{_paint('36', '━━━ ' + msg + ' ━━━')}")


def debug(msg: str, verbose_on: bool) -> None:
    if verbose_on:
        print(f"  [debug] {msg}")


# ---------------------------------------------------------------------------
# Home / base-dir resolution
# ---------------------------------------------------------------------------


def get_home() -> Path:
    try:
        home = Path.home()
        if str(home) and str(home) not in ("~", "."):
            return home
    except Exception:
        pass
    for var in ("HOME", "USERPROFILE"):
        val = os.environ.get(var, "").strip()
        if val and Path(val).is_dir():
            return Path(val)
    drive = os.environ.get("HOMEDRIVE", "")
    path = os.environ.get("HOMEPATH", "")
    if drive and path and Path(drive + path).is_dir():
        return Path(drive + path)
    raise RuntimeError("Could not determine a home directory (HOME/USERPROFILE unset).")


def base_dir(args) -> Path:
    if getattr(args, "base_dir", ""):
        raw = os.path.expandvars(os.path.expanduser(args.base_dir.strip()))
        return Path(raw)
    env = os.environ.get("XCODE_MCP_HOME", "").strip()
    if env:
        return Path(os.path.expandvars(os.path.expanduser(env)))
    return get_home() / ".xcode-mcp"


def pid_path(args) -> Path:
    if getattr(args, "pidfile", ""):
        raw = os.path.expandvars(os.path.expanduser(args.pidfile.strip()))
        return Path(raw)
    return base_dir(args) / "run" / PID_NAME


def log_path(args) -> Path:
    if getattr(args, "log_file", ""):
        raw = os.path.expandvars(os.path.expanduser(args.log_file.strip()))
        return Path(raw)
    return base_dir(args) / "logs" / LOG_NAME


# ---------------------------------------------------------------------------
# Process inspection (cross-platform, no third-party deps)
# ---------------------------------------------------------------------------


def pid_alive(pid: int) -> bool:
    """True if a process with this pid exists (any process — verify identity separately)."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just not ours
    except OSError:
        return False
    return True


def proc_cmdline(pid: int, verbose_on: bool = False) -> str | None:
    """Best-effort full command line for pid, or None if the process is gone."""
    # Linux fast path: /proc
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        if raw:
            return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError as exc:
        debug(f"/proc read for {pid}: {exc}", verbose_on)
    # POSIX fallback: ps
    if os.name == "posix":
        try:
            completed = subprocess.run(
                ["ps", "-p", str(pid), "-o", "args="],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=10, text=True, errors="replace",
            )
            if completed.returncode == 0 and completed.stdout.strip():
                return completed.stdout.strip()
        except (OSError, subprocess.TimeoutExpired) as exc:
            debug(f"ps fallback for {pid}: {exc}", verbose_on)
        return None
    # Windows: WMIC command line, falling back to tasklist image name.
    try:
        completed = subprocess.run(
            ["wmic", "process", "where", f"ProcessId={pid}",
             "get", "CommandLine", "/format:value"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=10, text=True, errors="replace", shell=False,
        )
        if completed.returncode == 0:
            for line in (completed.stdout or "").splitlines():
                if line.startswith("CommandLine="):
                    value = line[len("CommandLine="):].strip()
                    return value or None
    except (OSError, subprocess.TimeoutExpired) as exc:
        debug(f"wmic fallback for {pid}: {exc}", verbose_on)
    try:
        completed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=10, text=True, errors="replace", shell=False,
        )
        if completed.returncode == 0 and re.search(rf'"{pid}"', completed.stdout or ""):
            match = re.search(r'"([^"]+)"', completed.stdout or "")
            return match.group(1) if match else "unknown"
    except (OSError, subprocess.TimeoutExpired) as exc:
        debug(f"tasklist fallback for {pid}: {exc}", verbose_on)
    return None


def cmdline_is_ours(cmdline: str | None, server_file: str) -> bool:
    """Check the cmdline looks like our node server (guards against PID reuse)."""
    if not cmdline:
        return False
    lowered = cmdline.lower()
    if "node" not in lowered:
        return False
    marker = os.path.basename(server_file).lower()  # index.js
    if marker and marker in lowered:
        return True
    if "xcode-mcp" in lowered:
        return True
    return False


# ---------------------------------------------------------------------------
# Pidfile handling (JSON, written atomically)
# ---------------------------------------------------------------------------


def read_pidfile(path: Path) -> dict | None:
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return None
    except OSError as exc:
        warn(f"Could not read pidfile {path}: {exc}")
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        warn(f"Pidfile {path} is corrupt — treating as stale.")
        return {"corrupt": True, "path": str(path)}
    return data if isinstance(data, dict) else {"corrupt": True, "path": str(path)}


def write_pidfile(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def remove_pidfile(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        warn(f"Could not remove pidfile {path}: {exc}")


def daemon_state(args, verbose_on: bool) -> tuple:
    """Return (status, info) where status is 'running', 'stopped' or 'stale'."""
    pidfile = pid_path(args)
    data = read_pidfile(pidfile)
    if not data:
        return "stopped", {"pidfile": str(pidfile)}
    if data.get("corrupt"):
        return "stale", {"pidfile": str(pidfile), "reason": "corrupt pidfile"}
    pid = data.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return "stale", {"pidfile": str(pidfile), "reason": "bad pid in pidfile"}
    server_file = data.get("server", "")
    if not pid_alive(pid):
        return "stale", {"pidfile": str(pidfile), "pid": pid, "reason": "process gone"}
    cmdline = proc_cmdline(pid, verbose_on)
    if cmdline is None:
        # Process exists but cmdline unreadable (e.g. permission): trust pid + token
        # only if the pidfile is fresh (< 1h); otherwise call it stale after a
        # second liveness probe to avoid killing an unrelated process.
        if pid_alive(pid):
            return "running", {"pidfile": str(pidfile), "pid": pid,
                               "unverified": True, **{k: v for k, v in data.items()
                                                      if k in ("started_at", "server",
                                                               "project", "log", "token")}}
        return "stale", {"pidfile": str(pidfile), "pid": pid,
                         "reason": "process vanished on re-probe"}
    if not cmdline_is_ours(cmdline, server_file or "index.js"):
        return "stale", {"pidfile": str(pidfile), "pid": pid,
                         "reason": f"pid reused by: {cmdline[:120]}"}
    merged = {"pidfile": str(pidfile), "pid": pid, "cmdline": cmdline}
    for key in ("started_at", "server", "project", "scheme", "log", "token"):
        if key in data:
            merged[key] = data[key]
    try:
        started = datetime.datetime.fromisoformat(str(data.get("started_at", "")))
        merged["uptime_s"] = max(
            0, int((datetime.datetime.now(datetime.timezone.utc).astimezone()
                    - started).total_seconds()))
    except (ValueError, TypeError, OSError):
        pass
    return "running", merged


# ---------------------------------------------------------------------------
# Log helpers
# ---------------------------------------------------------------------------


def tail_lines(path: Path, n: int) -> list:
    """Last n lines without loading the whole file (binary backwards scan)."""
    if n <= 0:
        return []
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            block_size = 8192
            data = b""
            lines: list = []
            pos = size
            while pos > 0 and len(lines) <= n:
                step = min(block_size, pos)
                pos -= step
                handle.seek(pos)
                data = handle.read(step) + data
                lines = data.split(b"\n")
                if pos == 0:
                    break
            # Drop the trailing partial line marker: split leaves b'' after final \n
            if data.endswith(b"\n"):
                lines = lines[:-1]
            wanted = lines[-n:]
            return [ln.decode("utf-8", "replace") for ln in wanted]
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise RuntimeError(f"Cannot read log {path}: {exc}") from exc


def follow_log(path: Path, lines: int, interval: float, quiet: bool) -> int:
    try:
        existing = tail_lines(path, lines)
    except FileNotFoundError:
        error(f"No log file at {path} — has the server ever started?")
        return 1
    except RuntimeError as exc:
        error(str(exc))
        return 1
    for line in existing:
        print(line)
    if not quiet:
        print(f"--- following {path} (Ctrl+C to stop) ---")
    try:
        pos = path.stat().st_size
    except OSError:
        pos = 0
    try:
        while True:
            time.sleep(interval)
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                warn("Log file removed — waiting for it to reappear...")
                pos = 0
                continue
            except OSError:
                continue
            if size < pos:
                # Rotated or truncated: start over.
                print("--- log rotated, reopening from start ---")
                pos = 0
            if size == pos:
                continue
            try:
                with open(path, "rb") as handle:
                    handle.seek(pos)
                    chunk = handle.read()
                    pos = handle.tell()
            except OSError:
                continue
            if chunk:
                sys.stdout.write(chunk.decode("utf-8", "replace"))
                sys.stdout.flush()
    except KeyboardInterrupt:
        print()
    return 0


def rotate_log_if_big(path: Path, max_mb: float, quiet: bool) -> None:
    if max_mb <= 0:
        return
    try:
        size = path.stat().st_size
    except (FileNotFoundError, OSError):
        return
    if size <= max_mb * 1024 * 1024:
        return
    backup = path.with_name(path.name + ".1")
    try:
        if backup.exists():
            backup.unlink()
        path.rename(backup)
        if not quiet:
            print(f"  Rotated oversized log ({size // 1024 // 1024} MB) -> {backup}")
    except OSError as exc:
        warn(f"Could not rotate log {path}: {exc}")


# ---------------------------------------------------------------------------
# Validation / env
# ---------------------------------------------------------------------------

_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_env_assignments(items) -> dict:
    env: dict = {}
    for item in items or []:
        if "=" not in item:
            raise ValueError(f"--env {item!r} must be KEY=VALUE.")
        key, _, value = item.partition("=")
        key = key.strip()
        if not _ENV_KEY_RE.fullmatch(key):
            raise ValueError(f"--env key {key!r} is not a valid env var name.")
        if len(value) > 65536:
            raise ValueError(f"--env value for {key} exceeds 64KB.")
        env[key] = value
    return env


def resolve_server(server_arg: str) -> Path:
    raw = (server_arg or "").strip() or str(REPO_ROOT / DEFAULT_SERVER_REL)
    expanded = os.path.expandvars(os.path.expanduser(raw))
    path = Path(expanded)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path


def build_child_env(args) -> dict:
    env = dict(os.environ)
    if getattr(args, "project_path", "") and args.project_path.strip():
        env["XCODE_PROJECT_PATH"] = os.path.expandvars(
            os.path.expanduser(args.project_path.strip()))
    if getattr(args, "scheme", "") and args.scheme.strip():
        env["XCODE_DEFAULT_SCHEME"] = args.scheme.strip()
    if getattr(args, "simulator", "") and args.simulator.strip():
        env["XCODE_DEFAULT_SIMULATOR"] = args.simulator.strip()
    if getattr(args, "log_level", "") and args.log_level.strip():
        env["XCODE_MCP_LOG_LEVEL"] = args.log_level.strip()
    env.update(parse_env_assignments(getattr(args, "env", []) or []))
    return env


def check_node(verbose_on: bool) -> bool:
    if shutil.which("node") is None:
        error("node not found in PATH — install Node.js 18+ first.")
        return False
    try:
        completed = subprocess.run(
            ["node", "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=15, text=True, errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired):
        error("Could not execute node.")
        return False
    match = re.search(r"v?(\d+)", (completed.stdout or "").strip())
    major = int(match.group(1)) if match else 0
    debug(f"node {(completed.stdout or '').strip()}", verbose_on)
    if major < 18:
        error(f"Node.js 18+ required (found {(completed.stdout or '').strip() or 'unknown'}).")
        return False
    return True


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_start(args) -> int:
    quiet = bool(args.quiet)
    verbose_on = bool(args.verbose) and not quiet
    server = resolve_server(getattr(args, "server_path", ""))
    if not server.exists():
        error(f"Server not found at {server}.")
        print(f"  Build it first: python3 install.py  (or npm run build in {REPO_ROOT})")
        return 1

    env = build_child_env(args)
    project = env.get("XCODE_PROJECT_PATH", "").strip()
    if not project:
        error("XCODE_PROJECT_PATH is not set.")
        print("  Pass --project-path /path/to/App.xcodeproj or export XCODE_PROJECT_PATH.")
        return 1

    status, state = daemon_state(args, verbose_on)
    if status == "running":
        if not getattr(args, "force", False):
            error(f"Server already running (pid {state.get('pid')}).")
            print("  Use 'restart', 'stop' first, or 'start --force'.")
            return 1
        warn(f"Already running (pid {state.get('pid')}) — --force: restarting.")
        code = cmd_stop(args)
        if code != 0:
            return code
    elif status == "stale":
        warn(f"Removing {state.get('reason', 'stale')} pidfile.")
        remove_pidfile(pid_path(args))

    if not check_node(verbose_on):
        return 1

    log = log_path(args)
    try:
        log.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        error(f"Cannot create log directory {log.parent}: {exc}")
        return 1
    rotate_log_if_big(log, float(getattr(args, "max_log_mb", DEFAULT_MAX_LOG_MB)), quiet)

    step("Starting xcode-mcp", quiet)
    debug(f"server: {server}", verbose_on)
    debug(f"project: {project}", verbose_on)
    debug(f"log: {log}", verbose_on)

    if getattr(args, "dry_run", False):
        print(f"[dry-run] would start: node {server}  (log: {log})")
        return 0

    try:
        log_handle = open(log, "ab")
    except OSError as exc:
        error(f"Cannot open log file {log}: {exc}")
        return 1

    # MCP servers speak over stdio and exit cleanly on stdin EOF, so a daemon
    # with stdin=DEVNULL would die instantly (exit 0). Instead, give the child
    # a pipe whose write end it inherits itself: the read end never sees EOF,
    # and the server idles until we SIGTERM it via `stop`.
    try:
        stdin_read, stdin_write = os.pipe()
    except OSError as exc:
        log_handle.close()
        error(f"Cannot create stdin pipe: {exc}")
        return 1
    try:
        os.set_inheritable(stdin_write, True)
    except OSError as exc:
        log_handle.close()
        os.close(stdin_read)
        os.close(stdin_write)
        error(f"Cannot prepare stdin pipe: {exc}")
        return 1

    popen_kwargs: dict = {
        "stdin": stdin_read,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "cwd": str(REPO_ROOT),
        "env": env,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
        popen_kwargs["pass_fds"] = [stdin_write]
    else:
        popen_kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
        # Windows has no pass_fds: inheriting all inheritable handles keeps the
        # pipe's write end alive in the child (stdin_read is dup'd to fd 0).
        popen_kwargs["close_fds"] = False
    try:
        proc = subprocess.Popen(["node", str(server)], **popen_kwargs)
    except OSError as exc:
        log_handle.close()
        os.close(stdin_read)
        os.close(stdin_write)
        error(f"Failed to launch node: {exc}")
        return 1
    finally:
        # Parent side of every fd can close; the child keeps its own copies.
        try:
            log_handle.close()
        except OSError:
            pass
    os.close(stdin_read)
    os.close(stdin_write)

    token = uuid.uuid4().hex[:12]
    write_pidfile(pid_path(args), {
        "pid": proc.pid,
        "token": token,
        "server": str(server),
        "project": project,
        "scheme": env.get("XCODE_DEFAULT_SCHEME", ""),
        "log": str(log),
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })

    # Grace window: catch instant crashes (bad project path, missing Xcode…)
    deadline = time.time() + max(0.5, float(getattr(args, "wait", START_GRACE_S)))
    while time.time() < deadline:
        time.sleep(0.2)
        if proc.poll() is not None:
            break
    if proc.poll() is not None:
        remove_pidfile(pid_path(args))
        error(f"Server exited immediately (code {proc.returncode}). Last log lines:")
        try:
            for line in tail_lines(log, 20):
                print(f"  {line}")
        except (FileNotFoundError, RuntimeError) as exc:
            print(f"  (could not read log: {exc})")
        print("  Check XCODE_PROJECT_PATH and that Xcode tools exist (macOS).")
        return 1

    info(f"Started xcode-mcp (pid {proc.pid})", quiet)
    if not quiet:
        print(f"  log:     {log}")
        print(f"  project: {project}")
        print("  Manage with: python3 serverctl.py status|logs|stop|restart")
    return 0


def _terminate(pid: int, sig) -> None:
    try:
        if os.name == "posix":
            os.kill(pid, sig)
        else:
            # Windows: os.kill(pid, SIGTERM) terminates the process.
            os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        raise
    except OSError:
        pass


def _wait_gone(pid: int, timeout_s: float) -> bool:
    deadline = time.time() + max(0, timeout_s)
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.2)
    return not pid_alive(pid)


def cmd_stop(args) -> int:
    quiet = bool(args.quiet)
    verbose_on = bool(args.verbose) and not quiet
    timeout = float(getattr(args, "timeout", STOP_GRACE_S))
    force = bool(getattr(args, "force", False))

    status, state = daemon_state(args, verbose_on)
    if status == "stopped":
        info("Server is not running (no pidfile).", quiet)
        return 0
    if status == "stale":
        warn(f"Pidfile is stale ({state.get('reason', 'unknown')}) — removing it.", quiet)
        remove_pidfile(pid_path(args))
        return 0

    pid = int(state["pid"])
    step(f"Stopping xcode-mcp (pid {pid})", quiet)
    try:
        if force:
            debug("force: SIGKILL immediately", verbose_on)
            _terminate(pid, _KILL_SIG)
            if _wait_gone(pid, KILL_GRACE_S):
                remove_pidfile(pid_path(args))
                info(f"Stopped (force, pid {pid}).", quiet)
                return 0
        else:
            _terminate(pid, _TERMINATE_SIG)
            if _wait_gone(pid, timeout):
                remove_pidfile(pid_path(args))
                info(f"Stopped (pid {pid}).", quiet)
                return 0
            warn(f"pid {pid} did not exit in {timeout:g}s — SIGKILL.", quiet)
            _terminate(pid, _KILL_SIG)
            if _wait_gone(pid, KILL_GRACE_S):
                remove_pidfile(pid_path(args))
                info(f"Stopped via SIGKILL (pid {pid}).", quiet)
                return 0
    except PermissionError:
        error(f"No permission to signal pid {pid} (owned by another user?).")
        print("  Try running stop as the same user that started the server.")
        return 1
    error(f"pid {pid} is still alive after SIGKILL — giving up (pidfile kept).")
    return 1


def cmd_restart(args) -> int:
    code = cmd_stop(args)
    if code != 0:
        return code
    # Tiny pause so the old stdio/port resources release before rebind.
    time.sleep(0.5)
    return cmd_start(args)


def cmd_status(args) -> int:
    quiet = bool(args.quiet)
    verbose_on = bool(args.verbose) and not quiet
    as_json = bool(getattr(args, "json", False))
    status, state = daemon_state(args, verbose_on)
    if status == "running":
        payload = {"running": True, **{k: v for k, v in state.items()
                                       if k != "cmdline" or verbose_on}}
        if as_json or quiet:
            if as_json:
                print(json.dumps(payload, indent=2))
            else:
                print(f"running (pid {state.get('pid')})")
        else:
            info(f"xcode-mcp is running (pid {state.get('pid')})")
            if state.get("uptime_s") is not None:
                print(f"  uptime:  {int(state['uptime_s'])}s")
            if state.get("project"):
                print(f"  project: {state['project']}")
            if state.get("log"):
                print(f"  log:     {state['log']}")
            if state.get("unverified"):
                warn("identity unverified (cmdline unreadable) — pid may be reused.")
        return 0
    if as_json:
        print(json.dumps({"running": False, **state}, indent=2))
    elif not quiet:
        if status == "stale":
            warn(f"xcode-mcp is not running ({state.get('reason', 'stale pidfile')}).")
        else:
            print("xcode-mcp is not running.")
    return 1


def cmd_logs(args) -> int:
    quiet = bool(args.quiet)
    lines = int(getattr(args, "lines", 100))
    if lines < 0:
        error("--lines must be >= 0.")
        return 2
    if lines > 100000:
        error("--lines capped at 100000 (avoid dumping huge logs to the terminal).")
        return 2
    path = log_path(args)
    if getattr(args, "follow", False):
        return follow_log(path, lines, FOLLOW_INTERVAL_S, quiet)
    try:
        for line in tail_lines(path, lines):
            print(line)
    except FileNotFoundError:
        error(f"No log file at {path} — has the server ever started?")
        return 1
    except RuntimeError as exc:
        error(str(exc))
        return 1
    return 0


def cmd_run(args) -> int:
    """Foreground run: same checks as start, but inherits stdio (for debugging)."""
    quiet = bool(args.quiet)
    verbose_on = bool(args.verbose) and not quiet
    server = resolve_server(getattr(args, "server_path", ""))
    if not server.exists():
        error(f"Server not found at {server}. Build it first: python3 install.py")
        return 1
    env = build_child_env(args)
    if not env.get("XCODE_PROJECT_PATH", "").strip():
        error("XCODE_PROJECT_PATH is not set.")
        print("  Pass --project-path /path/to/App.xcodeproj or export XCODE_PROJECT_PATH.")
        return 1
    status, state = daemon_state(args, verbose_on)
    if status == "running" and not getattr(args, "force", False):
        error(f"Daemon already running (pid {state.get('pid')}).")
        print("  Stop it first, or pass --force to run a second copy in front.")
        return 1
    if not check_node(verbose_on):
        return 1
    if not quiet:
        print(f"Running node {server} in the foreground (Ctrl+C to stop)...")
        if not sys.stdin.isatty():
            warn("stdin is not a terminal — this stdio server exits on stdin EOF, "
                 "so it may stop immediately. Use a terminal for interactive debugging, "
                 "or 'start' for background mode.")
    try:
        completed = subprocess.run(["node", str(server)], cwd=str(REPO_ROOT), env=env)
        return int(completed.returncode or 0)
    except KeyboardInterrupt:
        print()
        return 130
    except OSError as exc:
        error(f"Failed to launch node: {exc}")
        return 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-dir", default="",
                        help="State dir (default: $XCODE_MCP_HOME or ~/.xcode-mcp).")
    parser.add_argument("--pidfile", default="",
                        help="Custom pidfile path (default: <base>/run/xcode-mcp.pid).")
    parser.add_argument("--log-file", default="",
                        help="Custom log path (default: <base>/logs/xcode-mcp.log).")
    parser.add_argument("--server-path", default="",
                        help="Server entrypoint (default: <repo>/dist/index.js).")
    parser.add_argument("--quiet", "-q", action="store_true", help="Minimal output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug output.")


def _add_env_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project-path", default=os.environ.get("XCODE_PROJECT_PATH", ""),
                        help="Xcode project (.xcodeproj/.xcworkspace) or $XCODE_PROJECT_PATH.")
    parser.add_argument("--scheme", default=os.environ.get("XCODE_DEFAULT_SCHEME", ""),
                        help="Default scheme or $XCODE_DEFAULT_SCHEME.")
    parser.add_argument("--simulator", default=os.environ.get("XCODE_DEFAULT_SIMULATOR", ""),
                        help="Default simulator or $XCODE_DEFAULT_SIMULATOR.")
    parser.add_argument("--log-level", default=os.environ.get("XCODE_MCP_LOG_LEVEL", ""),
                        help="Log level or $XCODE_MCP_LOG_LEVEL.")
    parser.add_argument("--env", action="append", default=[],
                        help="Extra env KEY=VALUE (repeatable).")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="serverctl.py",
        description="Start, stop, restart and inspect the xcode-mcp server "
                    "(macOS, Windows, Linux).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start", help="Start the server as a background daemon.")
    p_start.add_argument("--force", action="store_true",
                         help="Restart if already running.")
    p_start.add_argument("--wait", type=float, default=START_GRACE_S,
                         help=f"Seconds to watch for early crashes (default {START_GRACE_S:g}).")
    p_start.add_argument("--max-log-mb", type=float, default=DEFAULT_MAX_LOG_MB,
                         help=f"Rotate log above this size in MB, 0 disables (default {DEFAULT_MAX_LOG_MB}).")
    p_start.add_argument("--dry-run", action="store_true",
                         help="Print what would be started without launching.")
    _add_env_flags(p_start)
    _add_common(p_start)
    p_start.set_defaults(func=cmd_start)

    p_stop = sub.add_parser("stop", help="Stop the background daemon.")
    p_stop.add_argument("--force", action="store_true",
                        help="SIGKILL immediately instead of graceful SIGTERM.")
    p_stop.add_argument("--timeout", type=float, default=STOP_GRACE_S,
                        help=f"SIGTERM grace in seconds (default {STOP_GRACE_S:g}).")
    _add_common(p_stop)
    p_stop.set_defaults(func=cmd_stop)

    p_restart = sub.add_parser("restart", help="Stop then start the daemon.")
    p_restart.add_argument("--force", action="store_true",
                           help="Pass through to start (restart even if running).")
    p_restart.add_argument("--wait", type=float, default=START_GRACE_S)
    p_restart.add_argument("--max-log-mb", type=float, default=DEFAULT_MAX_LOG_MB)
    p_restart.add_argument("--timeout", type=float, default=STOP_GRACE_S)
    p_restart.add_argument("--dry-run", action="store_true")
    _add_env_flags(p_restart)
    _add_common(p_restart)
    p_restart.set_defaults(func=cmd_restart)

    p_status = sub.add_parser("status", help="Show whether the daemon is running.")
    p_status.add_argument("--json", action="store_true",
                          help="Machine-readable JSON output.")
    _add_common(p_status)
    p_status.set_defaults(func=cmd_status)

    p_logs = sub.add_parser("logs", help="Show server log output.")
    p_logs.add_argument("--lines", "-n", type=int, default=100,
                        help="Number of trailing lines (default 100, max 100000).")
    p_logs.add_argument("--follow", "-f", action="store_true",
                        help="Keep following the log like tail -f.")
    _add_common(p_logs)
    p_logs.set_defaults(func=cmd_logs)

    p_run = sub.add_parser("run", help="Run the server in the foreground (debug).")
    p_run.add_argument("--force", action="store_true",
                       help="Run even if the daemon is already up.")
    _add_env_flags(p_run)
    _add_common(p_run)
    p_run.set_defaults(func=cmd_run)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        return int(args.func(args) or 0)
    except ValueError as exc:
        error(str(exc))
        return 2
    except RuntimeError as exc:
        error(str(exc))
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted by user.", file=sys.stderr)
        sys.exit(130)
    except BrokenPipeError:
        sys.exit(1)
