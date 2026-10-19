import io
import json
import logging

import pytest

from arkrecord_backend import PROTOCOL_VERSION, __version__
from arkrecord_backend.app import build_methods
from arkrecord_backend.rpc import (
    APP_ERROR,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    AppError,
    handle_line,
    serve,
)


def call(line, methods=None):
    return handle_line(line, methods if methods is not None else build_methods())


def request(method, id_=1, **extra):
    return json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, **extra})


def test_ping():
    response = call(request("ping"))
    assert response["id"] == 1
    result = response["result"]
    assert result["pong"] is True
    assert result["protocol"] == PROTOCOL_VERSION
    assert result["backend"] == __version__
    assert result["python"].startswith("3.")


@pytest.mark.parametrize("params", [{}, []])
def test_ping_accepts_empty_params(params):
    assert call(request("ping", params=params))["result"]["pong"] is True


def test_ping_rejects_params():
    assert call(request("ping", params={"x": 1}))["error"]["code"] == INVALID_PARAMS


def test_string_id_is_echoed():
    assert call(request("ping", id_="abc"))["id"] == "abc"


def test_parse_error():
    response = call("{not json")
    assert response == {"jsonrpc": "2.0", "id": None, "error": {"code": PARSE_ERROR, "message": "Parse error"}}


@pytest.mark.parametrize(
    "message",
    [
        [],  # 批量请求不支持
        [{"jsonrpc": "2.0", "id": 1, "method": "ping"}],
        "ping",
        {"id": 1, "method": "ping"},  # 缺 jsonrpc
        {"jsonrpc": "1.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "id": 1, "method": 5},
        {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": "x"},
        {"jsonrpc": "2.0", "id": True, "method": "ping"},
        {"jsonrpc": "2.0", "id": {"a": 1}, "method": "ping"},
    ],
)
def test_invalid_request(message):
    response = call(json.dumps(message))
    assert response["error"]["code"] == INVALID_REQUEST


def test_invalid_request_keeps_valid_id():
    assert call(json.dumps({"jsonrpc": "1.0", "id": 7, "method": "ping"}))["id"] == 7


def test_method_not_found():
    assert call(request("nope"))["error"]["code"] == METHOD_NOT_FOUND


def test_notifications_get_no_response():
    assert call(json.dumps({"jsonrpc": "2.0", "method": "ping"})) is None
    assert call(json.dumps({"jsonrpc": "2.0", "method": "nope"})) is None


def test_app_error_has_kind():
    def fail(params):
        raise AppError("link_expired", "抽卡链接已过期")

    response = call(request("fail"), {"fail": fail})
    assert response["error"] == {"code": APP_ERROR, "message": "抽卡链接已过期", "data": {"kind": "link_expired"}}


def test_internal_error_hides_details_and_logs_redacted(caplog):
    def boom(params):
        raise RuntimeError("upstream said token=abc123")

    with caplog.at_level(logging.ERROR):
        response = call(request("boom"), {"boom": boom})
    assert response["error"] == {"code": INTERNAL_ERROR, "message": "Internal error"}
    assert "abc123" not in json.dumps(response)


def test_serve_handles_crlf_and_blank_lines():
    lines = [
        "\r\n",
        request("ping", id_=1) + "\r\n",
        "   \n",
        json.dumps({"jsonrpc": "2.0", "method": "ping"}) + "\n",
        request("ping", id_=2) + "\n",
    ]
    out = io.StringIO()
    serve(build_methods(), lines, out)
    output = out.getvalue()
    assert output.endswith("\n") and "\r" not in output
    responses = [json.loads(line) for line in output.splitlines()]
    assert [r["id"] for r in responses] == [1, 2]


def test_serve_keeps_non_ascii():
    def echo(params):
        return params

    out = io.StringIO()
    serve({"echo": echo}, [request("echo", params=["寻访"]) + "\n"], out)
    assert "寻访" in out.getvalue()


def test_serve_ignores_bom():
    out = io.StringIO()
    serve(build_methods(), ["\ufeff" + request("ping") + "\r\n"], out)
    assert json.loads(out.getvalue())["result"]["pong"] is True
