"""桌面版的图片：假的来源站，不发真实请求。"""

import base64

import pytest

from arkrecord_backend.app import build_methods
from arkrecord_backend.hg import UpstreamResponse
from arkrecord_backend.images import CACHE_SECONDS, MAX_IMAGE_BYTES, MISSING_SECONDS, Images, load_sources
from arkrecord_backend.rpc import INVALID_PARAMS, RpcError

PNG = b"\x89PNG\r\n\x1a\nfake"
HASH = "0123456789abcdef0123456789abcdef"


class FakeSource:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response or UpstreamResponse(200, [("Content-Type", "image/png")], PNG)
        self.error = error

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": dict(headers)})
        if self.error:
            raise self.error
        return self.response


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


def images(tmp_path, source=None, clock=None):
    return Images(load_sources(), tmp_path, source or FakeSource(), clock or Clock())


@pytest.mark.parametrize(
    ("source", "target", "url"),
    [
        ("prts-avatar", "char_002_amiya", "https://torappu.prts.wiki/assets/char_avatar/char_002_amiya.png"),
        ("hycdn", f"upload/image/20260109/{HASH}.png", f"https://web.hycdn.cn/upload/image/20260109/{HASH}.png"),
    ],
)
def test_whitelisted_images(tmp_path, source, target, url):
    fake = FakeSource()
    result = images(tmp_path, fake).fetch({"source": source, "target": target})
    assert result == {"status": 200, "contentType": "image/png", "body": base64.b64encode(PNG).decode()}
    assert fake.calls[0]["url"] == url
    assert fake.calls[0]["headers"]["user-agent"].startswith("ArkRecord-Desktop/")


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ("prts-avatar", "../../w/index.php"),
        ("prts-avatar", "char_002_amiya.png"),
        ("prts-avatar", "char_002_amiya\n"),
        ("prts-avatar", "char_é"),
        ("prts", "char_002_amiya"),
        ("hycdn", "upload/image/20260109/not-a-hash.png"),
        ("__class__", "x"),
    ],
)
def test_other_paths_are_rejected_without_requests(tmp_path, source, target):
    fake = FakeSource()
    assert images(tmp_path, fake).fetch({"source": source, "target": target}) == {"status": 404}
    assert fake.calls == []


def test_cached_for_30_days(tmp_path):
    fake, clock = FakeSource(), Clock()
    img = images(tmp_path, fake, clock)
    params = {"source": "prts-avatar", "target": "char_002_amiya"}
    first = img.fetch(params)
    clock.now += CACHE_SECONDS - 1
    assert img.fetch(params) == first
    assert len(fake.calls) == 1
    clock.now += 2
    img.fetch(params)
    assert len(fake.calls) == 2


def test_missing_images_are_cached_for_an_hour(tmp_path):
    fake, clock = FakeSource(UpstreamResponse(404, [], b"")), Clock()
    img = images(tmp_path, fake, clock)
    params = {"source": "prts-avatar", "target": "char_9999_new"}
    assert img.fetch(params) == {"status": 404}
    assert img.fetch(params) == {"status": 404}
    assert len(fake.calls) == 1
    clock.now += MISSING_SECONDS + 1
    img.fetch(params)
    assert len(fake.calls) == 2


@pytest.mark.parametrize(
    "response",
    [
        UpstreamResponse(200, [("Content-Type", "text/html")], b"<html>"),
        UpstreamResponse(302, [("Location", "https://evil.example/")], b""),
        UpstreamResponse(500, [("Content-Type", "image/png")], PNG),
        UpstreamResponse(200, [("Content-Type", "image/png")], b"x" * (MAX_IMAGE_BYTES + 1)),
    ],
)
def test_bad_upstream_responses_are_not_cached(tmp_path, response):
    fake = FakeSource(response)
    img = images(tmp_path, fake)
    params = {"source": "prts-avatar", "target": "char_002_amiya"}
    assert img.fetch(params) == {"status": 502}
    img.fetch(params)
    assert len(fake.calls) == 2


def test_network_error(tmp_path):
    assert images(tmp_path, FakeSource(error=OSError("x"))).fetch(
        {"source": "prts-avatar", "target": "char_002_amiya"}
    ) == {"status": 502}


def test_works_without_data_dir(monkeypatch):
    monkeypatch.delenv("ARKRECORD_DATA_DIR", raising=False)
    fake = FakeSource()
    img = Images(load_sources(), None, fake, Clock())
    params = {"source": "prts-avatar", "target": "char_002_amiya"}
    assert img.fetch(params)["status"] == 200
    img.fetch(params)
    assert len(fake.calls) == 2


@pytest.mark.parametrize("params", [None, {}, {"source": "prts-avatar"}, {"source": 1, "target": "x"}])
def test_invalid_params(tmp_path, params):
    with pytest.raises(RpcError) as info:
        images(tmp_path).fetch(params)
    assert info.value.code == INVALID_PARAMS


def test_registered():
    assert "img.fetch" in build_methods()
