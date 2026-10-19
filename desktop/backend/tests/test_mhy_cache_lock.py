"""游戏运行时缓存文件被占用：Windows 上尽量共享读取；还是读不了时明确报 cache_locked，不退回旧版本的过期链接。"""

import os
import sys

import pytest
from mhy_fakes import GENSHIN_PAGE, FakeMhy, cache_blob, make_install

from arkrecord_backend.mhy import service as service_module
from arkrecord_backend.mhy.cache import read_cache
from arkrecord_backend.mhy.gacha import GachaApi
from arkrecord_backend.mhy.inspect import main as inspect_main
from arkrecord_backend.mhy.service import MhyService
from arkrecord_backend.rpc import AppError

NEW = GENSHIN_PAGE.format(key="FAKE_NEW")
OLD = GENSHIN_PAGE.format(key="FAKE_OLD")


def install(tmp_path):
    return make_install(tmp_path / "Game", versions={"5.1.0.0": cache_blob(NEW), "5.0.0.0": cache_blob(OLD)})


def service():
    return MhyService(api=GachaApi(send=FakeMhy(), sleep=lambda _: None))


def lock(monkeypatch, version):
    real = service_module.read_cache

    def fake(path):
        if path.parent.parent.parent.name == version:
            raise PermissionError(13, "sharing violation")
        return real(path)

    monkeypatch.setattr(service_module, "read_cache", fake)


def test_newest_cache_locked_is_an_error_not_a_fallback(tmp_path, monkeypatch):
    data = install(tmp_path)
    lock(monkeypatch, "5.1.0.0")
    fake = FakeMhy()
    with pytest.raises(AppError) as info:
        MhyService(api=GachaApi(send=fake, sleep=lambda _: None)).read_cache({"game": "genshin", "dataDir": str(data)})
    assert info.value.kind == "cache_locked" and "关闭游戏" in info.value.message
    # 没有拿旧目录的链接去校验
    assert fake.calls == []


def test_older_cache_locked_is_skipped(tmp_path, monkeypatch):
    data = install(tmp_path)
    lock(monkeypatch, "5.0.0.0")
    links = service().find_links(service_module.GAMES["genshin"], str(data))
    assert [link.param("authkey") for link in links] == ["FAKE_NEW"]


def test_inspect_marks_locked_cache(tmp_path, monkeypatch, capsys):
    data = install(tmp_path)
    from arkrecord_backend.mhy import inspect as inspect_module

    real = inspect_module.read_cache

    def fake(path):
        if path.parent.parent.parent.name == "5.1.0.0":
            raise PermissionError(13, "sharing violation")
        return real(path)

    monkeypatch.setattr(inspect_module, "read_cache", fake)
    inspect_main(["genshin", str(data)])
    out = capsys.readouterr().out
    assert "5.1.0.0：被占用（游戏可能正在运行）" in out and "FAKE" not in out


@pytest.mark.skipif(sys.platform != "win32", reason="只有 Windows 有共享模式")
def test_windows_shared_read_while_another_handle_allows_delete(tmp_path):
    import ctypes
    from ctypes import wintypes

    path = tmp_path / "data_2"
    path.write_bytes(b"hello cache")
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
    generic_rw_delete = 0x80000000 | 0x40000000 | 0x00010000

    # 像游戏那样：读写 + 删除权限打开，允许别人读、写、删除
    shared = kernel32.CreateFileW(str(path), generic_rw_delete, 0x7, None, 3, 0x80, None)
    assert shared not in (None, wintypes.HANDLE(-1).value)
    try:
        assert read_cache(path) == b"hello cache"
    finally:
        kernel32.CloseHandle(shared)

    # 独占打开（不允许别人读）：读不了，抛 PermissionError
    exclusive = kernel32.CreateFileW(str(path), 0x80000000 | 0x40000000, 0, None, 3, 0x80, None)
    assert exclusive not in (None, wintypes.HANDLE(-1).value)
    try:
        with pytest.raises(PermissionError):
            read_cache(path)
    finally:
        kernel32.CloseHandle(exclusive)
    assert os.path.exists(path)
