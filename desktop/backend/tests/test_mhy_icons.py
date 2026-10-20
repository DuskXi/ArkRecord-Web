"""原神、星铁的图标（BWIKI）：假的 BWIKI，不发真实请求。名称都是常见的公开角色 / 武器名。"""

import json
from urllib.parse import parse_qs, urlparse

import pytest

from arkrecord_backend.app import build_methods
from arkrecord_backend.hg import UpstreamResponse
from arkrecord_backend.images import Images, load_sources
from arkrecord_backend.mhy.icons import (
    BACKOFF_START_S,
    FOUND_TTL_S,
    MAX_LOOKUPS_PER_CALL,
    MIN_INTERVAL_S,
    MISSING_TTL_S,
    MhyIcons,
)
from arkrecord_backend.rpc import INVALID_PARAMS, RpcError

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


def icons(tmp_path, wiki, clock=None):
    clock = clock or Clock()
    return MhyIcons(tmp_path, wiki, clock, clock.sleep)


def test_looks_up_file_icons_for_the_given_names(tmp_path):
    wiki = FakeWiki({"文件:琴.png": {"url": file_url("ys", 1)}, "文件:天空之刃.png": {"url": file_url("ys", 2)}})
    result = icons(tmp_path, wiki).icons({"game": "genshin", "names": ["琴", "天空之刃", "没有这个", "琴"]})
    assert result == {
        "items": {"琴": file_url("ys", 1)[len(HOST) :], "天空之刃": file_url("ys", 2)[len(HOST) :]},
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
    assert result["items"] == {"丹恒•饮月": file_url("sr", 3)[len(HOST) :]}
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
    assert (tmp_path / "mhy-icons" / "genshin.json").is_file()

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


def test_batches_of_50_spaced_out_and_at_most_200_per_call(tmp_path):
    clock = Clock()
    names = [f"名称{i}" for i in range(260)]
    wiki = FakeWiki({f"文件:{n}.png": {"url": file_url("ys", i)} for i, n in enumerate(names)})
    source = icons(tmp_path, wiki, clock)
    result = source.icons({"game": "genshin", "names": names})
    assert len(wiki.calls) == MAX_LOOKUPS_PER_CALL // 50
    assert all(len(c["query"]["titles"].split("|")) == 50 for c in wiki.calls)
    assert len(clock.slept) == len(wiki.calls) - 1 and all(s == pytest.approx(MIN_INTERVAL_S) for s in clock.slept)
    assert (len(result["items"]), result["complete"]) == (200, False)
    # 下一次调用查剩下的
    result = source.icons({"game": "genshin", "names": names})
    assert (len(result["items"]), result["complete"]) == (260, True)


@pytest.mark.parametrize("wiki", [FakeWiki(status=567), FakeWiki(status=403), FakeWiki(error=TimeoutError())])
def test_failures_back_off_and_keep_the_cache(tmp_path, wiki):
    clock = Clock()
    good = FakeWiki({"文件:琴.png": {"url": file_url("ys", 1)}})
    icons(tmp_path, good, clock).icons({"game": "genshin", "names": ["琴"]})

    source = icons(tmp_path, wiki, clock)
    result = source.icons({"game": "genshin", "names": ["琴", "刻晴"]})
    assert result == {"items": {"琴": file_url("ys", 1)[len(HOST) :]}, "complete": False}
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
