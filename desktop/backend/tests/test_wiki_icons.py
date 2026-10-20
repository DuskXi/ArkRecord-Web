"""原神、星铁、终末地的图标（BWIKI）：假的 BWIKI，不发真实请求。名称都是常见的公开角色 / 武器名。"""

import json
from urllib.parse import parse_qs, urlparse

import pytest

from arkrecord_backend.app import build_methods
from arkrecord_backend.bili import API_INTERVAL_S, BACKOFF_START_S, BiliGuard
from arkrecord_backend.hg import UpstreamResponse
from arkrecord_backend.images import Images, load_sources
from arkrecord_backend.rpc import INVALID_PARAMS, RpcError
from arkrecord_backend.wikiicons import (
    FOUND_TTL_S,
    MAX_REQUESTS_PER_CALL,
    MISSING_TTL_S,
    WikiIcons,
)

HOST = "https://patchwiki.biligame.com/"


def file_url(wiki, n):
    return f"{HOST}images/{wiki}/{n % 10}/{n % 10}{n % 10}/abcdefghijklmnopqrstuvwxyz{n:05d}.png"


class FakeWiki:
    """按请求里的 titles 回答：files 里有的给图片信息，其余是 missing。"""

    def __init__(self, files=None, status=200, normalized=None, error=None):
        self.files = files or {}
        self.status = status
        self.normalized = normalized or {}
        self.error = error
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        parsed = urlparse(url)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        self.calls.append({"host": parsed.netloc, "path": parsed.path, "query": query, "headers": dict(headers)})
        if self.error:
            raise self.error
        if self.status != 200:
            return UpstreamResponse(self.status, [], b"")
        titles = query["titles"].split("|")
        normalized = [{"from": t, "to": self.normalized[t]} for t in titles if t in self.normalized]
        pages = []
        for title in titles:
            final = self.normalized.get(title, title)
            info = self.files.get(final)
            if info is None:
                pages.append({"ns": 6, "title": final, "missing": True})
            else:
                pages.append({"ns": 6, "title": final, "imageinfo": [{"size": 30000, "mime": "image/png", **info}]})
        payload = {"batchcomplete": True, "query": {"normalized": normalized, "pages": pages}}
        return UpstreamResponse(200, [("content-type", "application/json")], json.dumps(payload).encode())


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def icons(tmp_path, wiki, clock=None, guard=None):
    clock = clock or Clock()
    return WikiIcons(tmp_path, wiki, clock, guard or BiliGuard(tmp_path, clock, clock.sleep))


def test_looks_up_file_icons_for_the_given_names(tmp_path):
    wiki = FakeWiki({"文件:琴.png": {"url": file_url("ys", 1)}, "文件:天空之刃.png": {"url": file_url("ys", 2)}})
    result = icons(tmp_path, wiki).icons({"game": "genshin", "names": ["琴", "天空之刃", "没有这个", "琴"]})
    assert result == {
        "items": {
            "琴": "bwiki/" + file_url("ys", 1)[len(HOST) :],
            "天空之刃": "bwiki/" + file_url("ys", 2)[len(HOST) :],
        },
        "complete": True,
    }
    call = wiki.calls[0]
    assert (call["host"], call["path"]) == ("wiki.biligame.com", "/ys/api.php")
    assert call["query"]["prop"] == "imageinfo"
    assert call["query"]["titles"].split("|") == ["文件:琴.png", "文件:天空之刃.png", "文件:没有这个.png"]
    assert call["headers"]["user-agent"].startswith("ArkRecord-Desktop/")


def test_star_rail_uses_its_own_wiki_and_follows_normalized_titles(tmp_path):
    wiki = FakeWiki(
        {"文件:丹恒·饮月.png": {"url": file_url("sr", 3)}}, normalized={"文件:丹恒•饮月.png": "文件:丹恒·饮月.png"}
    )
    result = icons(tmp_path, wiki).icons({"game": "starrail", "names": ["丹恒•饮月"]})
    assert result["items"] == {"丹恒•饮月": "bwiki/" + file_url("sr", 3)[len(HOST) :]}
    assert wiki.calls[0]["path"] == "/sr/api.php"


@pytest.mark.parametrize(
    "info",
    [
        {"url": "https://example.com/images/ys/1/11/abcdefghijklmnopqrstuvwxyz00001.png"},
        {"url": file_url("sr", 1)},  # 原神的名称查到了星铁的图
        {"url": f"{HOST}images/ys/thumb/1/11/abcdefghijklmnopqrstuvwxyz00001.png/128px-x.png"},
        {"url": file_url("ys", 1), "size": 5 * 1024 * 1024},
        {"url": file_url("ys", 1), "mime": "text/html"},
    ],
)
def test_unexpected_image_info_is_ignored(tmp_path, info):
    wiki = FakeWiki({"文件:琴.png": info})
    assert icons(tmp_path, wiki).icons({"game": "genshin", "names": ["琴"]})["items"] == {}


def test_cached_on_disk_found_for_30_days_missing_for_a_day(tmp_path):
    clock = Clock()
    wiki = FakeWiki({"文件:琴.png": {"url": file_url("ys", 1)}})
    params = {"game": "genshin", "names": ["琴", "没有这个"]}
    first = icons(tmp_path, wiki, clock).icons(params)
    assert len(wiki.calls) == 1
    assert (tmp_path / "wiki-icons" / "genshin.json").is_file()

    # 重新启动（新的实例）也用缓存
    clock.now += MISSING_TTL_S - 10
    assert icons(tmp_path, wiki, clock).icons(params) == first
    assert len(wiki.calls) == 1

    # 没有的过了一天再查，查到的不重查
    clock.now += 20
    icons(tmp_path, wiki, clock).icons(params)
    assert wiki.calls[1]["query"]["titles"] == "文件:没有这个.png"

    clock.now += FOUND_TTL_S
    icons(tmp_path, wiki, clock).icons(params)
    assert set(wiki.calls[2]["query"]["titles"].split("|")) == {"文件:琴.png", "文件:没有这个.png"}


def test_batches_of_50_spaced_out_and_at_most_two_requests_per_call(tmp_path):
    clock = Clock()
    names = [f"名称{i}" for i in range(130)]
    wiki = FakeWiki({f"文件:{n}.png": {"url": file_url("ys", i)} for i, n in enumerate(names)})
    source = icons(tmp_path, wiki, clock)
    result = source.icons({"game": "genshin", "names": names})
    assert len(wiki.calls) == MAX_REQUESTS_PER_CALL == 2
    assert all(len(c["query"]["titles"].split("|")) == 50 for c in wiki.calls)
    assert clock.slept == [pytest.approx(API_INTERVAL_S)]
    assert (len(result["items"]), result["complete"]) == (100, False)
    # 下一次调用查剩下的，和上一次请求也隔开
    result = source.icons({"game": "genshin", "names": names})
    assert (len(result["items"]), result["complete"]) == (130, True)
    assert len(clock.slept) == 2


@pytest.mark.parametrize("wiki", [FakeWiki(status=567), FakeWiki(status=403), FakeWiki(error=TimeoutError())])
def test_failures_back_off_and_keep_the_cache(tmp_path, wiki):
    clock = Clock()
    good = FakeWiki({"文件:琴.png": {"url": file_url("ys", 1)}})
    icons(tmp_path, good, clock).icons({"game": "genshin", "names": ["琴"]})

    source = icons(tmp_path, wiki, clock)
    result = source.icons({"game": "genshin", "names": ["琴", "刻晴"]})
    assert result == {"items": {"琴": "bwiki/" + file_url("ys", 1)[len(HOST) :]}, "complete": False}
    assert len(wiki.calls) == 1

    # 退避期间不再请求
    clock.now += BACKOFF_START_S - 10
    source.icons({"game": "genshin", "names": ["刻晴"]})
    assert len(wiki.calls) == 1
    # 退避过后再试；又失败时等两倍时间
    clock.now += 20
    source.icons({"game": "genshin", "names": ["刻晴"]})
    assert len(wiki.calls) == 2
    clock.now += BACKOFF_START_S + 10
    source.icons({"game": "genshin", "names": ["刻晴"]})
    assert len(wiki.calls) == 2
    clock.now += BACKOFF_START_S
    source.icons({"game": "genshin", "names": ["刻晴"]})
    assert len(wiki.calls) == 3


def test_invalid_names_are_skipped_without_requests(tmp_path):
    wiki = FakeWiki()
    result = icons(tmp_path, wiki).icons({"game": "genshin", "names": ["a|b", "", "x" * 41, "<script>", "line\nbreak"]})
    assert result == {"items": {}, "complete": True}
    assert wiki.calls == []


@pytest.mark.parametrize(
    "params",
    [
        None,
        {"game": "genshin"},
        {"game": "zzz", "names": []},
        {"game": "genshin", "names": "琴"},
        {"game": "genshin", "names": [1]},
    ],
)
def test_invalid_params(tmp_path, params):
    with pytest.raises(RpcError) as error:
        icons(tmp_path, FakeWiki()).icons(params)
    assert error.value.code == INVALID_PARAMS


def test_registered_and_icons_load_through_the_desktop_image_source(tmp_path):
    assert "mhy.icons" in build_methods()
    target = file_url("ys", 1)[len(HOST) :]
    shared_only = load_sources(desktop=False)
    assert "bwiki" not in shared_only
    images = Images(load_sources(), tmp_path)
    assert images.resolve("bwiki", target) == f"{HOST}{target}"
    for bad in (
        "images/ys/thumb/1/11/abcdefghijklmnopqrstuvwxyz00001.png/128px-x.png",
        "images/zz/1/11/abcdefghijklmnopqrstuvwxyz00001.png",
        "images/ys/1/11/../../../w/index.php",
        "images/ys/1/11/abcdefghijklmnopqrstuvwxyz00001.png?x=1",
    ):
        assert images.resolve("bwiki", bad) is None


def test_blocked_images_and_icon_lookups_back_off_together(tmp_path):
    from arkrecord_backend.images import Images, load_sources

    clock = Clock()
    guard = BiliGuard(tmp_path, clock, clock.sleep)
    blocked_image = FakeImage(UpstreamResponse(567, [], b""))
    images = Images(load_sources(), tmp_path, blocked_image, clock, guard)
    target = file_url("ys", 1)[len(HOST) :]
    assert images.fetch({"source": "bwiki", "target": target}) == {"status": 502}
    assert guard.blocked()

    # 图片被拦下后，查图标也先不发请求
    wiki = FakeWiki({"文件:琴.png": {"url": file_url("ys", 1)}})
    assert icons(tmp_path, wiki, clock, guard).icons({"game": "genshin", "names": ["琴"]}) == {
        "items": {},
        "complete": False,
    }
    assert wiki.calls == []
    # 其他图片也不下载
    assert images.fetch({"source": "bwiki", "target": file_url("ys", 2)[len(HOST) :]}) == {"status": 502}
    assert len(blocked_image.calls) == 1
    # 重新启动后也记得
    assert BiliGuard(tmp_path, clock, clock.sleep).blocked()

    clock.now += BACKOFF_START_S + 1
    assert icons(tmp_path, wiki, clock, guard).icons({"game": "genshin", "names": ["琴"]})["complete"] is True
    assert not guard.blocked()


class FakeImage:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append(url)
        return self.response


def test_endfield_tries_avatar_then_icon_and_the_name_without_spaces(tmp_path):
    zmd = "images/zmd/1/11/abcdefghijklmnopqrstuvwxyz00001.png"
    wiki = FakeWiki(
        {
            "文件:佩丽卡头像.png": {"url": HOST + zmd},
            "文件:佩丽卡图标.png": {"url": HOST + zmd.replace("00001", "00002")},
            "文件:某武器图标.png": {"url": HOST + zmd.replace("00001", "00003")},
            "文件:LastRite头像.png": {"url": HOST + zmd.replace("00001", "00004")},
        }
    )
    result = icons(tmp_path, wiki).icons({"game": "endfield", "names": ["佩丽卡", "某武器", "Last Rite", "没有"]})
    assert result["items"] == {
        "佩丽卡": "bwiki/" + zmd,
        "某武器": "bwiki/" + zmd.replace("00001", "00003"),
        "Last Rite": "bwiki/" + zmd.replace("00001", "00004"),
    }
    call = wiki.calls[0]
    assert call["path"] == "/zmd/api.php"
    assert "文件:Last Rite头像.png" in call["query"]["titles"].split("|")


def test_endfield_batches_count_titles_not_names(tmp_path):
    clock = Clock()
    names = [f"干员{i}" for i in range(30)]
    wiki = FakeWiki()
    icons(tmp_path, wiki, clock).icons({"game": "endfield", "names": names})
    # 每个名称两个标题（头像、图标），一次最多 50 个标题
    assert [len(c["query"]["titles"].split("|")) for c in wiki.calls] == [50, 10]


def test_mhy_icons_only_takes_mihoyo_games_and_old_cache_is_reused(tmp_path):
    methods = build_methods(icons=icons(tmp_path, FakeWiki()))
    with pytest.raises(RpcError):
        methods["mhy.icons"]({"game": "endfield", "names": []})
    assert methods["wiki.icons"]({"game": "endfield", "names": []}) == {"items": {}, "complete": True}

    old = tmp_path / "mhy-icons"
    old.mkdir()
    target = file_url("ys", 1)[len(HOST) :]
    clock = Clock()
    entry = {"target": target, "checkedAt": clock.now}
    (old / "genshin.json").write_text(json.dumps({"version": 1, "items": {"琴": entry}}), encoding="utf-8")
    wiki = FakeWiki()
    assert icons(tmp_path, wiki, clock).icons({"game": "genshin", "names": ["琴"]})["items"] == {
        "琴": "bwiki/" + target
    }
    assert wiki.calls == []


SKLAND_A = "image/common/20261014/4826366/6acf92a9b8edfebe3af524e0_56331367.png"
SKLAND_B = "image/2026/01/12/2641152/40da4202dc8dd5d4a943077b195f5f25.png"


class FakeWikiAndIndex(FakeWiki):
    """BWIKI 的接口加上 GitHub 上的森空岛头像索引。"""

    def __init__(self, files=None, index=None, index_status=200):
        super().__init__(files)
        self.index = index if index is not None else {}
        self.index_status = index_status
        self.index_calls = 0

    def __call__(self, method, url, headers, body, timeout):
        if url.startswith("https://raw.githubusercontent.com/"):
            self.index_calls += 1
            assert "referer" not in {k.lower() for k in headers}
            return UpstreamResponse(self.index_status, [], json.dumps(self.index).encode())
        return super().__call__(method, url, headers, body, timeout)


def test_endfield_falls_back_to_skland_by_item_id(tmp_path):
    zmd = "images/zmd/1/11/abcdefghijklmnopqrstuvwxyz00001.png"
    index = {
        "avatar/chr_0036_jsspsi": {"source": "skland", "url": "https://bbs.hycdn.cn/" + SKLAND_A},
        "avatar/chr_9000_endmin-male": {"url": "https://bbs.hycdn.cn/" + SKLAND_B},
        # 别的域名、别的形式的地址都不认
        "avatar/chr_0099_evil": {"url": "https://example.com/" + SKLAND_A},
        "avatar/chr_0098_odd": {"url": "https://bbs.hycdn.cn/image/../x.png"},
        "fullBody/chr_0036_jsspsi": {"url": "https://bbs.hycdn.cn/" + SKLAND_B},
    }
    wiki = FakeWikiAndIndex({"文件:佩丽卡头像.png": {"url": HOST + zmd}}, index)
    clock = Clock()
    source = icons(tmp_path, wiki, clock)
    params = {
        "game": "endfield",
        "names": ["佩丽卡", "祀", "管理员", "坏的", "怪的", "没有"],
        "ids": {
            "佩丽卡": "chr_0004_pelica",
            "祀": "chr_0036_jsspsi",
            "管理员": "chr_0002_endminm",
            "坏的": "chr_0099_evil",
            "怪的": "chr_0098_odd",
        },
    }
    result = source.icons(params)
    assert result["items"] == {"佩丽卡": "bwiki/" + zmd, "祀": "skland/" + SKLAND_A, "管理员": "skland/" + SKLAND_B}
    assert wiki.index_calls == 1
    # 索引一天最多拉一次（重启后也用本机保存的）
    icons(tmp_path, wiki, clock).icons(params)
    assert wiki.index_calls == 1
    assert "fullBody" not in (tmp_path / "skland-avatars.json").read_text(encoding="utf-8")
    clock.now += 24 * 3600 + 1
    icons(tmp_path, wiki, clock).icons(params)
    assert wiki.index_calls == 2


def test_skland_index_failures_keep_the_old_index_and_wait_an_hour(tmp_path):
    clock = Clock()
    wiki = FakeWikiAndIndex(index={"avatar/chr_0036_jsspsi": {"url": "https://bbs.hycdn.cn/" + SKLAND_A}})
    params = {"game": "endfield", "names": ["祀"], "ids": {"祀": "chr_0036_jsspsi"}}
    assert icons(tmp_path, wiki, clock).icons(params)["items"] == {"祀": "skland/" + SKLAND_A}
    wiki.index_status = 503
    clock.now += 24 * 3600 + 1
    source = icons(tmp_path, wiki, clock)
    assert source.icons(params)["items"] == {"祀": "skland/" + SKLAND_A}
    assert wiki.index_calls == 2
    clock.now += 60
    source.icons(params)
    assert wiki.index_calls == 2


def test_other_games_ignore_ids_and_bad_ids_are_rejected(tmp_path):
    wiki = FakeWikiAndIndex()
    assert icons(tmp_path, wiki).icons({"game": "genshin", "names": ["琴"], "ids": {"琴": "x"}})["items"] == {}
    assert wiki.index_calls == 0
    with pytest.raises(RpcError):
        icons(tmp_path, wiki).icons({"game": "endfield", "names": [], "ids": ["x"]})


@pytest.mark.parametrize(
    ("target", "ok"),
    [
        (SKLAND_A, True),
        (SKLAND_B, True),
        ("image/common/20261014/4826366/../../x.png", False),
        ("image/common/20261014/4826366/6acf92a9b8edfebe3af524e0_56331367.png?x=1", False),
        ("api/user/info", False),
    ],
)
def test_skland_image_source(tmp_path, target, ok):
    images = Images(load_sources(), tmp_path)
    expected = f"https://bbs.hycdn.cn/{target}" if ok else None
    assert images.resolve("skland", target) == expected
    assert "skland" not in load_sources(desktop=False)
