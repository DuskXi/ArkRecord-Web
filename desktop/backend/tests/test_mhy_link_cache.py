"""解析抽卡链接、从缓存里找链接、找游戏目录。全部是合成数据。"""

import sys
from pathlib import Path

import pytest
from mhy_fakes import GENSHIN_PAGE, STARRAIL_API, cache_blob, make_install

from arkrecord_backend.mhy.cache import cache_files, gacha_urls, version_dirs
from arkrecord_backend.mhy.games import GENSHIN, STARRAIL
from arkrecord_backend.mhy.link import KEEP_PARAMS, parse_link
from arkrecord_backend.mhy.locate import data_dirs_in_log, find_data_dirs, log_paths, resolve_data_dir

# ---- 链接 ----


def test_parse_genshin_page_link_keeps_only_needed_params():
    link = parse_link(GENSHIN_PAGE.format(key="FAKE%2Bkey%2F1%3D"))
    assert link.game is GENSHIN and link.game_biz == "hk4e_cn" and link.upstream == "hk4e_cn"
    assert link.param("authkey") == "FAKE+key/1="
    assert [k for k, _ in link.params] == [
        "authkey",
        "authkey_ver",
        "sign_type",
        "auth_appid",
        "game_biz",
        "region",
        "lang",
    ]
    assert set(dict(link.params)) <= set(KEEP_PARAMS)
    assert link.param("timestamp") is None and link.param("device_type") is None


def test_raw_plus_in_authkey_is_kept():
    assert parse_link(GENSHIN_PAGE.format(key="FAKE+raw")).param("authkey") == "FAKE+raw"


def test_parse_starrail_api_link_and_path_variant():
    link = parse_link(STARRAIL_API.format(key="FAKE"))
    assert link.game is STARRAIL and link.upstream == "hkrpg_cn" and link.api_base == "gacha_record"
    alt = parse_link(STARRAIL_API.format(key="FAKE").replace("/gacha_record/", "/hkrpg_gacha_record/"))
    assert alt.api_base == "hkrpg_gacha_record"
    old_host = parse_link(
        STARRAIL_API.format(key="FAKE").replace("public-operation-hkrpg.mihoyo.com", "api-takumi.mihoyo.com")
    )
    assert old_host.upstream == "hkrpg_cn"


def test_global_link_and_params_after_hash():
    url = "https://gs.hoyoverse.com/genshin/event/e20190909gacha-v3/index.html#/log?authkey=FAKE&game_biz=hk4e_global"
    link = parse_link(url)
    assert link.upstream == "hk4e_global" and link.param("authkey") == "FAKE" and link.param("lang") == "zh-cn"


@pytest.mark.parametrize(
    "url",
    [
        "http://webstatic.mihoyo.com/gacha?authkey=FAKE&game_biz=hk4e_cn",
        "https://webstatic.mihoyo.com/gacha?game_biz=hk4e_cn",
        "https://webstatic.mihoyo.com/gacha?authkey=FAKE&game_biz=nap_cn",
        "https://webstatic.mihoyo.com/gacha?authkey=FAKE&game_biz=hk4e_bilibili",
        "https://webstatic.mihoyo.com/other?authkey=FAKE&game_biz=hk4e_cn",
        "https://webstatic.mihoyo.com/gacha?authkey=FAKE&game_biz=hk4e_cn&x=" + "a" * 9000,
        "not a url",
    ],
)
def test_rejects_other_links(url):
    assert parse_link(url) is None


# ---- 缓存 ----


def test_version_dirs_are_filtered_and_sorted(tmp_path):
    data = make_install(tmp_path, versions={"2.9.0.0": b"", "2.55.0.0": b"", "2.53.0.0": None})
    assert [d.name for d in version_dirs(data)] == ["2.55.0.0", "2.53.0.0", "2.9.0.0"]
    # 没有 data_2 的版本目录不算
    assert [p.parent.parent.parent.name for p in cache_files(data)] == ["2.55.0.0", "2.9.0.0"]


def test_gacha_urls_newest_first_and_deduplicated():
    a, b = GENSHIN_PAGE.format(key="FAKE_A"), GENSHIN_PAGE.format(key="FAKE_B")
    blob = (
        cache_blob(a, b, a) + b'"https://webstatic.mihoyo.com/gacha?game_biz=hk4e_cn"' + b"https://x.example/?authkey=Z"
    )
    urls = gacha_urls(blob)
    assert urls == [a, b]


def test_gacha_urls_stop_at_binary_and_quotes():
    url = GENSHIN_PAGE.format(key="FAKE")
    assert gacha_urls(b'xx"' + url.encode() + b'"yy') == [url]
    assert gacha_urls(url.encode() + b"\xff\x00tail") == [url]


# ---- 找目录 ----


GENSHIN_LOG = """[Subsystems] Discovering subsystems at path C:/Old/Genshin Impact Game/YuanShen_Data/UnitySubsystems
something else
[Subsystems] Discovering subsystems at path D:/Games/Genshin Impact/Genshin Impact Game/YuanShen_Data/UnitySubsystems
"""


def test_data_dirs_in_log_latest_first():
    assert data_dirs_in_log(GENSHIN_LOG, GENSHIN) == [
        Path("D:/Games/Genshin Impact/Genshin Impact Game/YuanShen_Data"),
        Path("C:/Old/Genshin Impact Game/YuanShen_Data"),
    ]


def test_data_dirs_in_starrail_log_with_backslashes():
    text = "Loading player data from G:\\Star Rail\\Game\\StarRail_Data\\data.unity3d\n"
    assert data_dirs_in_log(text, STARRAIL) == [Path("G:/Star Rail/Game/StarRail_Data")]


def test_log_paths(tmp_path):
    paths = log_paths(STARRAIL, tmp_path)
    assert paths[0] == tmp_path / "AppData" / "LocalLow" / "miHoYo" / "崩坏：星穹铁道" / "Player.log"


@pytest.mark.skipif(sys.platform != "win32", reason="日志里是 Windows 路径（带盘符）")
def test_find_data_dirs_from_log_on_windows(tmp_path):
    data = make_install(tmp_path / "Genshin Impact Game", versions={"2.55.0.0": b""})
    log = log_paths(GENSHIN, tmp_path / "home")[0]
    log.parent.mkdir(parents=True)
    log.write_text(f"[Subsystems] Discovering subsystems at path {data.as_posix()}/UnitySubsystems\n", encoding="utf-8")
    logs, dirs = find_data_dirs(GENSHIN, tmp_path / "home")
    assert logs == [log] and dirs == [data]


def test_find_data_dirs_without_logs(tmp_path):
    assert find_data_dirs(GENSHIN, tmp_path) == ([], [])


def test_resolve_data_dir_accepts_several_choices(tmp_path):
    launcher = tmp_path / "miHoYo Launcher" / "games"
    data = make_install(launcher / "Genshin Impact Game", versions={"2.55.0.0": b""})
    assert resolve_data_dir(data, GENSHIN) == data
    assert resolve_data_dir(data / "webCaches", GENSHIN) == data
    assert resolve_data_dir(data.parent, GENSHIN) == data
    assert resolve_data_dir(launcher, GENSHIN) == data
    assert resolve_data_dir(tmp_path / "missing", GENSHIN) is None
    assert resolve_data_dir(data, STARRAIL) is None


def test_inspect_prints_counts_but_no_values(tmp_path, capsys):
    from arkrecord_backend.mhy.inspect import main

    data = make_install(
        tmp_path, versions={"2.55.0.0": b"", "2.54.0.0": cache_blob(GENSHIN_PAGE.format(key="FAKE_SECRET"))}
    )
    assert main(["genshin", str(data)]) == 0
    out = capsys.readouterr().out
    assert "能用的抽卡链接 1 条" in out and "hk4e_cn" in out and "authkey" in out
    assert "FAKE_SECRET" not in out and "fakegacha" not in out
    assert main(["zzz"]) == 2
