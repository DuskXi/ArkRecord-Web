"""游戏运行时缓存文件被占用：Windows 上尽量共享读取；还是读不了时明确报 cache_locked，不退回旧版本的过期链接。"""

import pytest
from mhy_fakes import GENSHIN_PAGE, FakeMhy, cache_blob, make_install

from arkrecord_backend.mhy import service as service_module
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
