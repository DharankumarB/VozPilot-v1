"""Isolated sandbox runner for the Developer Agent.

Enforces:
- Dedicated temporary directory per run (cleaned up immediately afterwards).
- No unrestricted shell (`shell=False`, allowlisted interpreters only).
- Stripped environment: zero host secrets, tokens or database credentials.
- Static Python AST guard rejecting network sockets, subprocess spawning, ctypes
  escape and path traversal outside the sandbox directory.
- POSIX resource limits (`RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`)
  plus wall-clock timeout with process-group SIGKILL.
- Read-only workspace file inspection jailed strictly inside the repository
  with sensitive paths (`.env`, `.git`, `.data`, credentials) hard-blocked.
"""

from __future__ import annotations

import ast
import os
import resource
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .config import REPO_ROOT, settings
from .security import SecurityViolationError, redact_secrets

BLOCKED_PYTHON_MODULES = {
    "socket",
    "ssl",
    "http",
    "urllib",
    "requests",
    "httpx",
    "aiohttp",
    "websocket",
    "websockets",
    "subprocess",
    "multiprocessing",
    "pty",
    "ctypes",
    "cffi",
    "mmap",
    "psycopg2",
    "shutil",
    "ftplib",
    "smtplib",
    "telnetlib",
    "xmlrpc",
}

BLOCKED_BUILTINS = {"eval", "exec", "compile", "__import__", "breakpoint", "input"}

BLOCKED_WORKSPACE_PREFIXES = (
    ".env",
    ".git",
    ".data",
    "node_modules",
    "vozcore/.venv",
)


def inspect_python_ast(code: str) -> list[str]:
    """Validate Python code AST before execution; return violations if unsafe."""
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return [f"SyntaxError at line {exc.lineno}: {exc.msg}"]

    violations: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in BLOCKED_PYTHON_MODULES:
                    violations.append(f"Import of '{root}' is forbidden in the isolated sandbox.")
                if root == "os":
                    violations.append("Direct 'os' module import is forbidden in the isolated sandbox.")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in BLOCKED_PYTHON_MODULES or root == "os":
                violations.append(f"Import from '{root}' is forbidden in the isolated sandbox.")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_BUILTINS:
                violations.append(f"Call to '{node.func.id}()' is forbidden in the isolated sandbox.")
            elif isinstance(node.func, ast.Name) and node.func.id == "open":
                # Allow relative paths inside sandbox dir only; forbid absolute or .. paths
                if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    target = node.args[0].value
                    if target.startswith("/") or ".." in Path(target).parts:
                        violations.append(f"Filesystem access outside sandbox is forbidden: '{target}'.")
        elif isinstance(node, ast.Attribute):
            if node.attr in {"__subclasses__", "__globals__", "__builtins__", "system", "popen", "fork", "execve"}:
                violations.append(f"Access to attribute '{node.attr}' is forbidden in the isolated sandbox.")

    return violations


def _apply_rlimits(cpu_seconds: int, memory_mb: int) -> None:
    """Child-process preexec hook: new process group + strict POSIX limits."""
    os.setsid()
    cpu = max(1, int(cpu_seconds))
    mem_bytes = max(64, int(memory_mb)) * 1024 * 1024
    max_file_bytes = 4 * 1024 * 1024  # 4 MB max file write
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_bytes, max_file_bytes))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except (ValueError, OSError):
        pass


def run_in_sandbox(
    code: str,
    language: str = "python",
    timeout_seconds: float | None = None,
    cpu_seconds: int | None = None,
    memory_mb: int | None = None,
) -> dict[str, Any]:
    """Execute Python code in a tightly isolated sandbox with resource limits."""
    lang = (language or "python").strip().lower()
    if lang not in {"python", "py"}:
        return {
            "ok": False,
            "exitCode": -1,
            "stdout": "",
            "stderr": f"Sandbox execution supports 'python' only (requested '{lang}').",
            "durationMs": 0,
            "timedOut": False,
            "blocked": True,
        }

    if len(code or "") > 40_000:
        return {
            "ok": False,
            "exitCode": -1,
            "stdout": "",
            "stderr": "Code exceeds the 40 KB sandbox size limit.",
            "durationMs": 0,
            "timedOut": False,
            "blocked": True,
        }

    violations = inspect_python_ast(code)
    if violations:
        return {
            "ok": False,
            "exitCode": -1,
            "stdout": "",
            "stderr": "Sandbox policy blocked execution:\n- " + "\n- ".join(violations),
            "durationMs": 0,
            "timedOut": False,
            "blocked": True,
            "violations": violations,
        }

    timeout = min(float(timeout_seconds or settings.sandbox_timeout_seconds), 30.0)
    cpu = min(int(cpu_seconds or settings.sandbox_cpu_seconds), 15)
    mem = min(int(memory_mb or settings.sandbox_memory_mb), 512)

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="vozpilot_sbx_") as tmpdir:
        script_path = Path(tmpdir) / "main.py"
        script_path.write_text(code, encoding="utf-8")

        # Sanitized environment: zero host secrets, tokens, or DB variables.
        clean_env = {
            "PATH": "/usr/bin:/bin",
            "HOME": tmpdir,
            "TMPDIR": tmpdir,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONIOENCODING": "utf-8",
            "LANG": "C.UTF-8",
        }

        proc = subprocess.Popen(
            [sys.executable, "-I", "-B", str(script_path)],
            cwd=tmpdir,
            env=clean_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
            preexec_fn=lambda: _apply_rlimits(cpu, mem),
        )
        timed_out = False
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = proc.communicate()

        duration_ms = int((time.monotonic() - started) * 1000)
        exit_code = proc.returncode if proc.returncode is not None else -9
        if exit_code == -signal.SIGXCPU:
            timed_out = True
            stderr = (stderr or "") + f"\nProcess exceeded CPU limit ({cpu}s)."

        return {
            "ok": (exit_code == 0) and not timed_out,
            "exitCode": exit_code,
            "stdout": redact_secrets((stdout or "")[:16_000]),
            "stderr": redact_secrets((stderr or "")[:16_000]),
            "durationMs": duration_ms,
            "timedOut": timed_out,
            "blocked": False,
            "limits": {"timeoutSeconds": timeout, "cpuSeconds": cpu, "memoryMb": mem},
        }


def read_workspace_source_safely(relative_path: str, max_bytes: int = 32_000) -> dict[str, Any]:
    """Read a source file inside the repository with strict path-jail & secret blocking."""
    cleaned = (relative_path or "").strip().lstrip("/")
    if not cleaned:
        raise SecurityViolationError("Source file path is empty.")
    root = REPO_ROOT.resolve()
    candidate = (root / cleaned).resolve()
    if root not in candidate.parents and candidate != root:
        raise SecurityViolationError("Path escapes the workspace root.")

    rel_posix = candidate.relative_to(root).as_posix()
    for prefix in BLOCKED_WORKSPACE_PREFIXES:
        if rel_posix == prefix or rel_posix.startswith(prefix + "/") or rel_posix.startswith(".env"):
            raise SecurityViolationError(f"Access to protected path '{rel_posix}' is denied.")
    if any(part.startswith(".env") or part in {".git", "credentials", "secrets"} for part in candidate.parts):
        raise SecurityViolationError(f"Access to sensitive path '{rel_posix}' is denied.")
    if not candidate.is_file():
        return {"exists": False, "path": rel_posix, "content": None}

    raw = candidate.read_text(encoding="utf-8", errors="replace")[:max_bytes]
    return {
        "exists": True,
        "path": rel_posix,
        "sizeBytes": candidate.stat().st_size,
        "content": redact_secrets(raw),
    }
