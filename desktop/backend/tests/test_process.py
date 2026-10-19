"""把后端当子进程启动，按主进程的方式收发消息。"""

import json
import subprocess
import sys
import tomllib
from pathlib import Path

from arkrecord_backend import __version__

BACKEND_DIR = Path(__file__).resolve().parents[1]


def run_backend(stdin: bytes) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [sys.executable, "-m", "arkrecord_backend"],
        input=stdin,
        capture_output=True,
        timeout=30,
        check=False,
    )


def test_ping_over_stdio_and_exit_on_eof():
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "method": "ping"},
        {"jsonrpc": "2.0", "id": "两", "method": "nope"},
    ]
    stdin = "".join(json.dumps(m, ensure_ascii=False) + "\r\n" for m in lines).encode("utf-8")
    proc = run_backend(stdin)
    assert proc.returncode == 0
    # stdout 只有协议消息，每行一个，UTF-8，换行是 \n
    assert b"\r" not in proc.stdout
    responses = {r["id"]: r for r in map(json.loads, proc.stdout.decode("utf-8").splitlines())}
    assert set(responses) == {1, "两"}
    assert responses[1]["result"]["pong"] is True
    assert responses["两"]["error"]["code"] == -32601
    # 启动日志在 stderr
    assert "后端已启动" in proc.stderr.decode("utf-8")


def test_version_matches_pyproject():
    pyproject = tomllib.loads((BACKEND_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == __version__
