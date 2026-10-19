"""从游戏的网页缓存（Chromium 磁盘缓存 data_2）里找抽卡链接。

- 只读打开，不复制：避免在临时目录留下含 authkey 的副本。Windows 上打开时允许别人同时读、写、删除
  （游戏打开缓存文件时可能要求别人也允许删除，普通的 open() 不允许，会读不了）；游戏独占时仍然读不了，
  抛 PermissionError，由调用方提示关闭游戏（2026-10-19 星铁实测：游戏开着时最新版本目录的 data_2 读不了）。
- webCaches 下还有 Cache、Network 等不是版本号的目录，按版本号格式过滤；从新版本往旧版本找
  （最新版本里可能还没打开过抽卡记录）。
- 不写死页面路径：按“有 authkey + 有 game_biz + 地址里有 gacha”匹配，页面地址和接口地址都算。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

VERSION_DIR_RE = re.compile(r"^\d+(?:\.\d+){1,3}$")
# 一条 URL：到空白、控制字符、引号、尖括号或非 ASCII 字节为止
URL_RE = re.compile(rb"https://[^\x00-\x20\"'<>\\\x7f-\xff]+")
MAX_CACHE_BYTES = 256 * 1024 * 1024


def version_dirs(data_dir: Path) -> list[Path]:
    """webCaches 下的版本目录，版本号从新到旧。"""
    web_caches = data_dir / "webCaches"
    if not web_caches.is_dir():
        return []
    dirs = [d for d in web_caches.iterdir() if d.is_dir() and VERSION_DIR_RE.match(d.name)]
    return sorted(dirs, key=lambda d: tuple(int(part) for part in d.name.split(".")), reverse=True)


def cache_files(data_dir: Path) -> list[Path]:
    """各版本目录里的 data_2，版本号从新到旧。"""
    files = (d / "Cache" / "Cache_Data" / "data_2" for d in version_dirs(data_dir))
    return [path for path in files if path.is_file()]


def read_cache(path: Path) -> bytes:
    """读出整个缓存文件。被别的进程独占时抛 PermissionError。"""
    if path.stat().st_size > MAX_CACHE_BYTES:
        raise OSError("缓存文件太大")
    if sys.platform == "win32":
        return _read_shared_windows(path)
    with path.open("rb") as file:
        return file.read()


def _read_shared_windows(path: Path) -> bytes:
    """Windows：用 CreateFileW 打开，允许别的进程同时读、写、删除（FILE_SHARE_READ | WRITE | DELETE）。"""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    generic_read = 0x80000000
    share_all = 0x1 | 0x2 | 0x4
    open_existing = 3
    attribute_normal = 0x80
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel32.CreateFileW
    create.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create.restype = wintypes.HANDLE
    handle = create(str(path), generic_read, share_all, None, open_existing, attribute_normal, None)
    if handle is None or handle == wintypes.HANDLE(-1).value:
        # 共享冲突（ERROR_SHARING_VIOLATION = 32）会变成 PermissionError
        raise ctypes.WinError(ctypes.get_last_error())
    fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    with open(fd, "rb") as file:
        return file.read()


def gacha_urls(data: bytes) -> list[str]:
    """缓存里和抽卡有关、带 authkey 的地址，后写入的排在前面，同一个 authkey 只留最后一条。"""
    found: dict[str, str] = {}
    for match in URL_RE.finditer(data):
        url = match.group(0).decode("ascii")
        lower = url.lower()
        if "authkey=" not in lower or "game_biz=" not in lower or "gacha" not in lower:
            continue
        key = _authkey_part(url)
        if not key:
            continue
        found.pop(key, None)
        found[key] = url
    return list(reversed(found.values()))


def _authkey_part(url: str) -> str | None:
    match = re.search(r"[?&#]authkey=([^&#]+)", url)
    return match.group(1) if match else None
