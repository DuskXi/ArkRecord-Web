"""打桌面版安装包用的后端：PyInstaller 把后端和 Python 打成一个文件夹（onedir）。

- 后端只用标准库，没有第三方依赖；打成文件夹而不是单个文件：启动快，也不用每次解压到临时目录。
- 输出 desktop/backend/dist/arkrecord-backend/，里面的 arkrecord-backend（Windows 是 .exe）就是后端；
  Electron 打包时把整个文件夹放进安装包的 resources/backend/，shared/ 放进 resources/shared/，
  主进程用 ARKRECORD_SHARED_DIR 告诉后端白名单文件在哪（desktop/README.md）。
- 打完后启动一次打好的后端，发 ping，确认能用（CI 上三个平台都会跑）。

运行（desktop/backend 目录）：uv sync --locked --group package && uv run python packaging/build.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "arkrecord-backend"
DIST = ROOT / "dist"
WORK = ROOT / "build"


def executable() -> Path:
    return DIST / NAME / (f"{NAME}.exe" if sys.platform == "win32" else NAME)


def build() -> Path:
    shutil.rmtree(DIST / NAME, ignore_errors=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onedir",
            "--console",
            "--name",
            NAME,
            "--distpath",
            str(DIST),
            "--workpath",
            str(WORK),
            "--specpath",
            str(WORK),
            "--paths",
            str(ROOT),
            str(ROOT / "packaging" / "entry.py"),
        ],
        check=True,
        cwd=ROOT,
    )
    return executable()


def check(exe: Path) -> dict:
    """启动打好的后端，发两个请求，读回复；后端读到输入结束就退出。

    - ping：能启动、协议正常；
    - img.fetch 一个白名单以外的来源：要读 shared/images.json；
    - hg.request 一个白名单以外的路径：要读 shared/upstreams/hg.json（鹰角两款的同步靠它）。
    后两个确认 ARKRECORD_SHARED_DIR 管用，都不发网络请求。
    """
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "id": 2, "method": "img.fetch", "params": {"source": "not-a-source", "target": "x"}},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "hg.request",
            "params": {"upstream": "not-an-upstream", "path": "/x", "envelope": "{}"},
        },
    ]
    result = subprocess.run(
        [str(exe)],
        input="".join(json.dumps(r) + "\n" for r in requests).encode("utf-8"),
        capture_output=True,
        timeout=120,
        env={**os.environ, "PYTHONUTF8": "1", "ARKRECORD_SHARED_DIR": str(ROOT.parents[1] / "shared")},
        check=False,
    )
    responses = {r.get("id"): r for r in map(json.loads, result.stdout.decode("utf-8").splitlines())}
    if result.returncode != 0 or len(responses) != len(requests):
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
        raise SystemExit(f"打好的后端没有正常回复（退出码 {result.returncode}）")
    if responses[1].get("result", {}).get("pong") is not True:
        raise SystemExit(f"ping 的回复不对：{responses[1]}")
    if responses[2].get("result") != {"status": 404}:
        raise SystemExit(f"img.fetch 的回复不对（读不到 shared/？）：{responses[2]}")
    if responses[3].get("result", {}).get("status") != 404:
        raise SystemExit(f"hg.request 的回复不对（读不到 shared/upstreams？）：{responses[3]}")
    return responses[1]["result"]


def main() -> int:
    # 控制台不是 UTF-8 时（英文版 Windows 是 cp1252，GitHub Actions 的 Windows 机器就是）打印中文会报错
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[union-attr]
    exe = build()
    info = check(exe)
    size = sum(f.stat().st_size for f in (DIST / NAME).rglob("*") if f.is_file())
    print(f"后端已打包：{exe}（{size / 1024 / 1024:.1f} MB）")
    print(f"ping 正常：backend {info['backend']}，Python {info['python']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
