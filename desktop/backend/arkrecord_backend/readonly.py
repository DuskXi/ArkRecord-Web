"""读用户电脑上别的程序（游戏）的文件：完全只读，不影响对方。

维护者的规则（2026-10-19，原话）：“以后读取文件使用影子读取法，不要独占文件，也不要影响或者对文件加什么状态会影响游戏运行的，
完全镜面只读”。读游戏的日志、缓存等文件一律走这里（见 docs/desktop/plan.md 的“读游戏文件的规则”）：

- 只申请读权限，打开时允许别的程序同时读、写、删除、改名（Windows：GENERIC_READ + FILE_SHARE_READ | WRITE | DELETE）。
  Python 自带的 open() 在 Windows 上不允许别人删除和改名：游戏轮换日志（Player.log → Player-prev.log）时
  如果正好被我们打开着，改名会失败，所以不用它。
- 句柄只在读的那一下打开：一次读进内存（有上限）就关闭；解析、发请求都在关闭之后。
- 不写、不加锁、不复制到磁盘、不改文件的属性和时间。
- 对方独占文件时不强行读（不用卷影复制：要管理员权限），抛 PermissionError，由调用方提示用户先关闭游戏。
- 读到的内容可能是对方写到一半的：调用方按“没解析到”处理，下次再读，不要高频重试。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import BinaryIO


def read_bytes(path: Path, max_bytes: int, *, tail: bool = False) -> bytes:
    """读出整个文件（超过 max_bytes 时报错）；tail=True 时只读最后 max_bytes 字节（日志用）。"""
    with open_shared(path) as file:
        size = os.fstat(file.fileno()).st_size
        if size > max_bytes:
            if not tail:
                raise OSError(f"文件太大（{size} 字节）")
            file.seek(size - max_bytes)
        return file.read(max_bytes)


def open_shared(path: Path) -> BinaryIO:
    """只读打开，不妨碍别的程序读、写、删除、改名。用完马上关闭（with 语句）。"""
    if sys.platform != "win32":
        # macOS / Linux 没有强制的共享模式：普通的只读打开不影响别的程序改名、删除
        return path.open("rb")
    return _open_shared_windows(path)


def _open_shared_windows(path: Path) -> BinaryIO:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    generic_read = 0x80000000
    share_all = 0x1 | 0x2 | 0x4  # FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
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
    # 调用方用 with 关闭
    return open(fd, "rb")
