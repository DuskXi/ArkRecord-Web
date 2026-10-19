"""读游戏文件的只读规则（readonly.py）：读完马上关闭、不妨碍别的程序读写删改名；独占时抛 PermissionError。"""

import os
import sys

import pytest

from arkrecord_backend.readonly import open_shared, read_bytes


def test_reads_whole_file_or_tail(tmp_path):
    path = tmp_path / "Player.log"
    path.write_bytes(b"0123456789")
    assert read_bytes(path, 100) == b"0123456789"
    assert read_bytes(path, 4, tail=True) == b"6789"
    with pytest.raises(OSError, match="文件太大"):
        read_bytes(path, 4)


def test_does_not_write_or_keep_the_file_open(tmp_path):
    path = tmp_path / "data_2"
    path.write_bytes(b"cache")
    before = path.stat().st_mtime_ns
    read_bytes(path, 100)
    assert path.stat().st_mtime_ns == before
    # 读完就关了：可以马上改名、删除
    path.rename(tmp_path / "data_2.old")
    (tmp_path / "data_2.old").unlink()


@pytest.mark.skipif(sys.platform != "win32", reason="只有 Windows 有共享模式")
def test_windows_open_lets_others_rename_and_delete(tmp_path):
    path = tmp_path / "Player.log"
    path.write_bytes(b"log")
    # 打开着的时候，游戏轮换日志（改名）、删除都不受影响
    with open_shared(path) as file:
        path.rename(tmp_path / "Player-prev.log")
        assert file.read() == b"log"
    (tmp_path / "Player-prev.log").unlink()


def _kernel32():
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    return kernel32, wintypes.HANDLE(-1).value


@pytest.mark.skipif(sys.platform != "win32", reason="只有 Windows 有共享模式")
def test_windows_reads_while_game_holds_delete_access_but_not_when_exclusive(tmp_path):
    path = tmp_path / "data_2"
    path.write_bytes(b"hello cache")
    kernel32, invalid = _kernel32()
    read_write_delete = 0x80000000 | 0x40000000 | 0x00010000

    # 像游戏那样：读写 + 删除权限打开，允许别人读、写、删除。普通的 open() 读不了，我们能读
    shared = kernel32.CreateFileW(str(path), read_write_delete, 0x7, None, 3, 0x80, None)
    assert shared not in (None, invalid)
    try:
        assert read_bytes(path, 100) == b"hello cache"
    finally:
        kernel32.CloseHandle(shared)

    # 独占打开（不允许别人读）：不强行读，抛 PermissionError
    exclusive = kernel32.CreateFileW(str(path), 0x80000000 | 0x40000000, 0, None, 3, 0x80, None)
    assert exclusive not in (None, invalid)
    try:
        with pytest.raises(PermissionError):
            read_bytes(path, 100)
    finally:
        kernel32.CloseHandle(exclusive)
    assert os.path.exists(path)
