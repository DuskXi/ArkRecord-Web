"""拉取抽卡记录和 RPC 方法：假的米哈游接口，不发真实请求。"""

import json

import pytest
from mhy_fakes import GENSHIN_PAGE, STARRAIL_API, FakeMhy, cache_blob, make_install

from arkrecord_backend.app import build_methods
from arkrecord_backend.hg import UpstreamResponse
from arkrecord_backend.mhy.gacha import MIN_INTERVAL_S, GachaApi
from arkrecord_backend.mhy.link import parse_link
from arkrecord_backend.mhy.service import MAX_HANDLES, MhyService
from arkrecord_backend.rpc import INVALID_PARAMS, AppError, RpcError


class Clock:
    def __init__(self):
        self.now = 100.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def api(fake, clock=None):
    clock = clock or Clock()
    return GachaApi(send=fake, sleep=clock.sleep, clock=clock)


def service(fake, tmp_path=None):
    return MhyService(api=api(fake), home=tmp_path)


# ---- GachaApi ----


def test_genshin_request_url():
    fake = FakeMhy()
    api(fake).fetch_page(parse_link(GENSHIN_PAGE.format(key="FAKE%2Bk%3D")), "301", "1700000000000000001", 20)
    call = fake.calls[0]
    assert call["host"] == "public-operation-hk4e.mihoyo.com" and call["path"] == "/gacha_info/api/getGachaLog"
    assert call["query"] == {
        "authkey": "FAKE+k=",
        "authkey_ver": "1",
        "sign_type": "2",
        "auth_appid": "webview_gacha",
        "game_biz": "hk4e_cn",
        "region": "cn_gf01",
        "lang": "zh-cn",
        "gacha_type": "301",
        "page": "1",
        "size": "20",
        "end_id": "1700000000000000001",
    }
    assert "%2B" in call["url"] and call["headers"]["user-agent"].startswith("ArkRecord-Desktop/")


def test_starrail_collab_pools_use_ld_endpoint():
    fake = FakeMhy()
    link = parse_link(STARRAIL_API.format(key="FAKE").replace("/gacha_record/", "/hkrpg_gacha_record/"))
    client = api(fake)
    client.fetch_page(link, "11")
    client.fetch_page(link, "21")
    assert [c["path"] for c in fake.calls] == [
        "/common/hkrpg_gacha_record/api/getGachaLog",
        "/common/hkrpg_gacha_record/api/getLdGachaLog",
    ]
    assert fake.calls[0]["host"] == "public-operation-hkrpg.mihoyo.com"


def test_requests_are_paced():
    clock = Clock()
    client = api(FakeMhy(), clock)
    link = parse_link(GENSHIN_PAGE.format(key="FAKE"))
    client.fetch_page(link, "200")
    client.fetch_page(link, "200")
    assert clock.slept == [pytest.approx(MIN_INTERVAL_S)]


def test_pacing_is_per_server_so_two_games_can_read_at_once():
    clock = Clock()
    client = api(FakeMhy(), clock)
    genshin = parse_link(GENSHIN_PAGE.format(key="FAKE_G"))
    starrail = parse_link(STARRAIL_API.format(key="FAKE_S"))
    client.fetch_page(genshin, "200")
    # 星铁是另一个服务器：不用等原神的间隔
    client.fetch_page(starrail, "1")
    assert clock.slept == []
    # 同一个服务器照旧间隔
    client.fetch_page(genshin, "200")
    assert clock.slept == [pytest.approx(MIN_INTERVAL_S)]


@pytest.mark.parametrize(
    ("key", "kind"), [("expired", "link_expired"), ("invalid", "link_invalid"), ("busy", "rate_limited")]
)
def test_retcodes(key, kind):
    with pytest.raises(AppError) as info:
        api(FakeMhy()).fetch_page(parse_link(GENSHIN_PAGE.format(key=f"FAKE_{key}")), "200")
    assert info.value.kind == kind


def test_http_error_and_bad_json():
    for response in (UpstreamResponse(500, [], b"{}"), UpstreamResponse(200, [], b"not json")):
        with pytest.raises(AppError) as info:
            api(lambda *a, r=response: r).fetch_page(parse_link(GENSHIN_PAGE.format(key="FAKE")), "200")
        assert info.value.kind == "upstream_error"


def test_network_error_does_not_leak_authkey(caplog):
    def fail(method, url, *rest):
        raise OSError(f"connect failed {url}")

    with pytest.raises(AppError) as info:
        api(fail).fetch_page(parse_link(GENSHIN_PAGE.format(key="FAKE_SECRET")), "200")
    assert info.value.kind == "network" and "FAKE_SECRET" not in info.value.message
    assert "FAKE_SECRET" not in caplog.text


def test_logs_do_not_contain_authkey(caplog):
    caplog.set_level("INFO")
    api(FakeMhy()).fetch_page(parse_link(GENSHIN_PAGE.format(key="FAKE_SECRET")), "200")
    assert "retcode 0" in caplog.text and "FAKE_SECRET" not in caplog.text


# ---- 读缓存 ----


def install(tmp_path, *older_urls, newest=b""):
    return make_install(tmp_path / "Game", versions={"2.55.0.0": newest, "2.54.0.0": cache_blob(*older_urls)})


def test_read_cache_skips_expired_and_returns_handle(tmp_path):
    data = install(tmp_path, GENSHIN_PAGE.format(key="FAKE_OK"), GENSHIN_PAGE.format(key="FAKE_expired"))
    fake = FakeMhy()
    result = service(fake).read_cache({"game": "genshin", "dataDir": str(data)})
    assert result["source"] == "cache" and result["game"] == "genshin" and result["gameBiz"] == "hk4e_cn"
    assert result["uid"] == "100000001" and result["region"] == "cn_gf01"
    # 后写入的（已过期）先校验，再换下一条
    assert [c["query"]["authkey"] for c in fake.calls] == ["FAKE_expired", "FAKE_OK"]
    assert all(c["query"]["size"] == "1" and c["query"]["gacha_type"] == "200" for c in fake.calls)
    assert "FAKE_OK" not in json.dumps(result)


def test_read_cache_ignores_other_games_links(tmp_path):
    data = install(tmp_path, STARRAIL_API.format(key="FAKE_OK"))
    with pytest.raises(AppError) as info:
        service(FakeMhy()).read_cache({"game": "genshin", "dataDir": str(data)})
    assert info.value.kind == "no_link"


def test_read_cache_all_expired(tmp_path):
    data = install(tmp_path, GENSHIN_PAGE.format(key="FAKE_expired"))
    with pytest.raises(AppError) as info:
        service(FakeMhy()).read_cache({"game": "genshin", "dataDir": str(data)})
    assert info.value.kind == "link_expired"


def test_read_cache_rate_limit_is_not_swallowed(tmp_path):
    data = install(tmp_path, GENSHIN_PAGE.format(key="FAKE_OK"), GENSHIN_PAGE.format(key="FAKE_busy"))
    with pytest.raises(AppError) as info:
        service(FakeMhy()).read_cache({"game": "genshin", "dataDir": str(data)})
    assert info.value.kind == "rate_limited"


def test_read_cache_game_not_found(tmp_path):
    for params in ({"game": "genshin", "dataDir": str(tmp_path)}, {"game": "genshin"}):
        with pytest.raises(AppError) as info:
            service(FakeMhy(), tmp_path).read_cache(params)
        assert info.value.kind == "game_not_found"


def test_cache_stamp(tmp_path):
    data = install(tmp_path, GENSHIN_PAGE.format(key="FAKE_OK"))
    stamp = service(FakeMhy()).cache_stamp({"game": "genshin", "dataDir": str(data)})
    assert isinstance(stamp["mtime"], float)


# ---- 粘贴链接、拉取、句柄 ----


def test_use_link_fetch_page_and_forget():
    svc = service(FakeMhy())
    handle = svc.use_link({"url": GENSHIN_PAGE.format(key="FAKE_OK")})["handle"]
    page = svc.fetch_page({"handle": handle, "gachaType": "301", "endId": "0", "size": 5})
    assert page["list"][0]["id"] == "1700000000000000001" and page["region"] == "cn_gf01"
    svc.forget({"handle": handle})
    with pytest.raises(AppError) as info:
        svc.fetch_page({"handle": handle, "gachaType": "301"})
    assert info.value.kind == "handle_expired"


def test_use_link_rejects_other_links():
    with pytest.raises(AppError) as info:
        service(FakeMhy()).use_link({"url": "https://example.com/?authkey=FAKE"})
    assert info.value.kind == "bad_link"


@pytest.mark.parametrize(
    "extra",
    [
        {"gachaType": "999"},
        {"gachaType": "301", "endId": "abc"},
        {"gachaType": "301", "size": 21},
        {"gachaType": "301", "size": True},
    ],
)
def test_fetch_page_validates_params(extra):
    svc = service(FakeMhy())
    handle = svc.use_link({"url": GENSHIN_PAGE.format(key="FAKE_OK")})["handle"]
    with pytest.raises(RpcError) as info:
        svc.fetch_page({"handle": handle, **extra})
    assert info.value.code == INVALID_PARAMS


def test_handles_are_capped():
    svc = service(FakeMhy())
    handles = [svc.use_link({"url": GENSHIN_PAGE.format(key=f"FAKE_{i}")})["handle"] for i in range(MAX_HANDLES + 1)]
    with pytest.raises(AppError):
        svc.fetch_page({"handle": handles[0], "gachaType": "200"})
    assert svc.fetch_page({"handle": handles[-1], "gachaType": "200"})["list"]


@pytest.mark.parametrize("params", [None, {}, {"game": "zzz"}, {"game": "genshin", "x": 1}])
def test_invalid_params(params):
    with pytest.raises(RpcError) as info:
        service(FakeMhy()).locate(params)
    assert info.value.code == INVALID_PARAMS


def test_locate_without_logs(tmp_path):
    result = service(FakeMhy(), tmp_path).locate({"game": "starrail"})
    assert result["logs"] == [] and result["dataDirs"] == [] and len(result["searched"]) == 4


def test_methods_are_registered():
    names = set(build_methods(mhy=service(FakeMhy())))
    assert {"mhy.locate", "mhy.cacheStamp", "mhy.readCache", "mhy.useLink", "mhy.fetchPage", "mhy.forget"} <= names


def test_mhy_whitelist_only_has_gacha_record_endpoints():
    from arkrecord_backend.mhy.gacha import default_upstreams

    upstreams = default_upstreams()
    assert set(upstreams) == {"hk4e_cn", "hk4e_global", "hkrpg_cn", "hkrpg_global"}
    for upstream in upstreams.values():
        assert upstream["host"].endswith((".mihoyo.com", ".hoyoverse.com"))
        for route in upstream["routes"]:
            assert route["method"] == "GET"
            assert route["path"].endswith(("/getGachaLog", "/getLdGachaLog"))
