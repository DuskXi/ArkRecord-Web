"""hg.request：用假的上游测试，不发真实请求。下面的 token、Cookie 都是合成的假值。"""

import json
from pathlib import Path

import pytest

from arkrecord_backend.hg import (
    AK_COOKIE_HEADER,
    MAX_BODY_BYTES,
    PROXY_HEADER,
    HgClient,
    UpstreamResponse,
    default_upstreams_path,
    form_encode,
    load_upstreams,
    parse_envelope,
)
from arkrecord_backend.rpc import INVALID_PARAMS, RpcError

REPO = Path(__file__).resolve().parents[3]


class FakeUpstream:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response or UpstreamResponse(200, [("Content-Type", "application/json")], b'{"code":0}')
        self.error = error

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body, "timeout": timeout})
        if self.error:
            raise self.error
        return self.response


def client(fake):
    return HgClient(load_upstreams(), send=fake)


def hg(fake, upstream, path, envelope):
    text = envelope if isinstance(envelope, str) else json.dumps(envelope)
    return client(fake).request({"upstream": upstream, "path": path, "envelope": text})


def test_default_path_is_the_shared_whitelist():
    assert default_upstreams_path() == REPO / "shared" / "upstreams" / "hg.json"
    upstreams = load_upstreams()
    assert upstreams["ak"]["relayAkCookie"] is True
    assert {r["path"] for r in upstreams["ef"]["routes"]} >= {"/api/record/char", "/api/record/weapon"}


def test_get_with_query_role_token_and_cookie():
    fake = FakeUpstream(
        UpstreamResponse(
            200,
            [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Set-Cookie", "other=1; Path=/"),
                ("Set-Cookie", "ak-user-center=FAKE%2Bcookie%3D; Path=/; HttpOnly"),
                ("X-Secret-Header", "must not leak"),
            ],
            '{"code":0,"data":{"list":["寻访"]}}'.encode(),
        )
    )
    result = hg(
        fake,
        "ak",
        "/user/api/inquiry/gacha/history",
        {"query": {"uid": "1", "category": "a b~*"}, "roleToken": "FAKE-role", "akCookie": "FAKE%2Bold"},
    )
    call = fake.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == "https://ak.hypergryph.com/user/api/inquiry/gacha/history?uid=1&category=a+b%7E*"
    assert call["body"] is None
    assert call["headers"]["x-role-token"] == "FAKE-role"
    assert call["headers"]["cookie"] == "ak-user-center=FAKE%2Bold"
    assert call["headers"]["referer"] == "https://ak.hypergryph.com/user/headhunting"
    assert "content-type" not in call["headers"]
    assert call["timeout"] == 20
    assert result == {
        "status": 200,
        "headers": {"content-type": "application/json; charset=utf-8", AK_COOKIE_HEADER: "FAKE%2Bcookie%3D"},
        "body": '{"code":0,"data":{"list":["寻访"]}}',
    }


def test_post_sends_json_body_without_cookie_relay():
    fake = FakeUpstream()
    hg(fake, "as", "/user/oauth2/v2/grant", {"body": {"token": "FAKE", "appCode": "x", "type": 0}})
    call = fake.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://as.hypergryph.com/user/oauth2/v2/grant"
    assert call["headers"]["content-type"] == "application/json"
    assert json.loads(call["body"]) == {"token": "FAKE", "appCode": "x", "type": 0}
    assert "cookie" not in call["headers"]


def test_cookie_is_only_relayed_for_ak():
    fake = FakeUpstream(UpstreamResponse(200, [("Set-Cookie", "ak-user-center=FAKE")], b"{}"))
    result = hg(fake, "ef", "/api/record/char", {"query": {"token": "FAKE"}, "akCookie": "FAKE"})
    assert "cookie" not in fake.calls[0]["headers"]
    assert AK_COOKIE_HEADER not in result["headers"]


def test_upstream_error_status_is_passed_through():
    fake = FakeUpstream(UpstreamResponse(401, [("content-type", "application/json")], b'{"code":40100}'))
    result = hg(fake, "ef", "/api/record/char", {"query": {}})
    assert result["status"] == 401 and result["body"] == '{"code":40100}'
    assert PROXY_HEADER not in result["headers"]


@pytest.mark.parametrize(
    ("upstream", "path"),
    [
        ("ak", "/user/api/role/logout"),
        ("ak", "/user/api/inquiry/gacha/history/"),
        ("nope", "/"),
        ("__class__", "/"),
        ("ak", "https://evil.example/user/api/role/login"),
    ],
)
def test_routes_outside_the_whitelist_are_rejected(upstream, path):
    fake = FakeUpstream()
    result = hg(fake, upstream, path, {})
    assert result["status"] == 404 and result["headers"][PROXY_HEADER] == "route_not_allowed"
    assert fake.calls == []


@pytest.mark.parametrize(
    "envelope",
    [
        "not json",
        [],
        {"extra": 1},
        {"query": {"bad key": "x"}},
        {"query": {"k": 1}},
        {"query": {"k": "x" * 2049}},
        {"query": {f"k{i}": "x" for i in range(17)}},
        {"body": {}},  # GET 不能带请求体
        {"roleToken": "has space"},
        {"akCookie": "bad;cookie"},
    ],
)
def test_bad_envelopes_are_rejected(envelope):
    fake = FakeUpstream()
    result = hg(fake, "ak", "/user/api/inquiry/gacha/cate", envelope)
    assert result["status"] == 400 and result["headers"][PROXY_HEADER] == "bad_request"
    assert fake.calls == []


def test_post_route_requires_body():
    assert parse_envelope("{}", "POST") is None
    assert parse_envelope('{"body": {}}', "POST") == {"body": {}}


def test_envelope_size_limit():
    fake = FakeUpstream()
    result = hg(fake, "ef", "/api/record/char", '{"query":{"k":"' + "x" * MAX_BODY_BYTES + '"}}')
    assert result["status"] == 413 and fake.calls == []


def test_network_error_does_not_leak_details(caplog):
    fake = FakeUpstream(error=OSError("connect failed for https://ef-webview.hypergryph.com/?token=FAKE_SECRET"))
    result = hg(fake, "ef", "/api/record/char", {"query": {"token": "FAKE_SECRET"}})
    assert result["status"] == 502 and result["headers"][PROXY_HEADER] == "upstream_unreachable"
    assert "FAKE_SECRET" not in json.dumps(result)
    assert "FAKE_SECRET" not in caplog.text


def test_logs_do_not_contain_query_or_body(caplog):
    caplog.set_level("INFO")
    hg(FakeUpstream(), "ef", "/api/record/char", {"query": {"token": "FAKE_SECRET"}})
    assert "/api/record/char" in caplog.text
    assert "FAKE_SECRET" not in caplog.text


@pytest.mark.parametrize(
    "params",
    [
        None,
        [],
        {"upstream": "ak", "path": "/"},
        {"upstream": 1, "path": "/", "envelope": "{}"},
        {"a": 1, "b": 2, "c": 3},
    ],
)
def test_invalid_params(params):
    with pytest.raises(RpcError) as info:
        client(FakeUpstream()).request(params)
    assert info.value.code == INVALID_PARAMS


@pytest.mark.parametrize(
    ("value", "encoded"),
    [
        ("abc-._*", "abc-._*"),
        ("a b", "a+b"),
        ("~", "%7E"),
        ("+/=", "%2B%2F%3D"),
        ("寻", "%E5%AF%BB"),
        ("&=?#", "%26%3D%3F%23"),
    ],
)
def test_form_encode_matches_url_search_params(value, encoded):
    assert form_encode(value) == encoded
