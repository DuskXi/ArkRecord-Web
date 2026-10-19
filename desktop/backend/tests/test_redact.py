import logging

import pytest

from arkrecord_backend.redact import MASK, RedactingFormatter, is_sensitive_key, redact_text, redact_value

# 下面全部是合成的假值


@pytest.mark.parametrize(
    "key",
    [
        "token",
        "roleToken",
        "akCookie",
        "authkey",
        "x-ak-user-center",
        "u8_token",
        "Set-Cookie",
        "stoken",
        "ltoken",
        "cookie_token",
        "game_ticket",
        "password",
        "Authorization",
        "sign_type",
    ],
)
def test_sensitive_keys(key):
    assert is_sensitive_key(key)


@pytest.mark.parametrize("key", ["uid", "nickName", "gacha_type", "page", "size", "end_id", "lang", "game_biz"])
def test_ordinary_keys(key):
    assert not is_sensitive_key(key)


def test_redact_value_nested():
    value = {
        "query": {"page": 1, "token": "fake-token-1"},
        "body": {"appCode": "x", "roleToken": "fake-role"},
        "list": [{"authkey": "fake-authkey"}, "keep"],
        "akCookie": "fake-cookie",
    }
    redacted = redact_value(value)
    assert redacted == {
        "query": {"page": 1, "token": MASK},
        "body": {"appCode": "x", "roleToken": MASK},
        "list": [{"authkey": MASK}, "keep"],
        "akCookie": MASK,
    }
    # 原值不变
    assert value["query"]["token"] == "fake-token-1"


def test_redact_gacha_link():
    url = (
        "https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?win_mode=fullscreen"
        "&authkey_ver=1&sign_type=2&authkey=FAKE%2Bkey%2Fvalue%3D%3D&lang=zh-cn&gacha_type=301&page=1&size=5"
    )
    redacted = redact_text(url)
    assert "FAKE" not in redacted
    assert f"authkey={MASK}" in redacted
    assert "gacha_type=301" in redacted and "lang=zh-cn" in redacted


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("Cookie: ak-user-center=FAKECOOKIE; other=1", "FAKECOOKIE"),
        ('{"token": "FAKETOKEN", "uid": "1"}', "FAKETOKEN"),
        ('{"roleToken":"FAKE\\"ESCAPED"}', "FAKE"),
        ("Authorization: Bearer FAKE.BEARER.VALUE", "FAKE.BEARER"),
        ("stoken=FAKESTOKEN;stuid=1", "FAKESTOKEN"),
    ],
)
def test_redact_text(text, secret):
    assert secret not in redact_text(text)


def test_redact_text_keeps_ordinary_text():
    text = "拉取第 3 页，共 20 条，gacha_type=301 retcode=0"
    assert redact_text(text) == text


def test_formatter_redacts_message_and_traceback():
    formatter = RedactingFormatter("%(message)s")
    try:
        raise ValueError("bad response for authkey=FAKE_IN_TRACEBACK")
    except ValueError:
        import sys

        record = logging.LogRecord("t", logging.ERROR, __file__, 1, "token=%s", ("FAKE_ARG",), sys.exc_info())
    output = formatter.format(record)
    assert "FAKE_ARG" not in output
    assert "FAKE_IN_TRACEBACK" not in output
