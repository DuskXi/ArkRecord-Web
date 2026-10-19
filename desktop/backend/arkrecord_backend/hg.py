"""鹰角请求信封：桌面版代替 Worker 执行页面发出的请求。

行为和 Worker 的 /api/hg/* 转发一致（worker/proxy.ts）：
- 只发 shared/upstreams/hg.json 白名单里的请求，路径精确匹配；
- 请求信封的格式和限制相同（ProxyEnvelope）；
- 不跟随重定向；只把 ak-user-center Cookie 交还给页面（x-ak-user-center）；
- 转发层自己的错误带 x-arkrecord-proxy，页面据此区分“转发层拒绝”和“上游返回的错误”。

日志只记上游名、路径、状态码和耗时，不记查询参数、请求体和响应内容（其中有 token）。
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__
from .rpc import INVALID_PARAMS, Params, RpcError

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 8192
UPSTREAM_TIMEOUT_S = 20
MAX_QUERY_PARAMS = 16
MAX_QUERY_VALUE = 2048
MAX_RESPONSE_BYTES = 8 * 1024 * 1024

AK_COOKIE_NAME = "ak-user-center"
AK_COOKIE_HEADER = "x-ak-user-center"
PROXY_HEADER = "x-arkrecord-proxy"

# 和 worker/proxy.ts 相同的规则（\w 只算 ASCII）
_QUERY_KEY_RE = re.compile(r"^[\w-]{1,64}$", re.ASCII)
_COOKIE_VALUE_RE = re.compile(r"^[\w%.~+/=-]{1,4096}$", re.ASCII)
_ROLE_TOKEN_RE = re.compile(r"^[\x21-\x7e]{1,4096}$")
_ENVELOPE_KEYS = {"query", "body", "roleToken", "akCookie"}

# 网页版转发的是浏览器自己的请求头；桌面版没有浏览器，如实标明是 ArkRecord 桌面版
USER_AGENT = f"ArkRecord-Desktop/{__version__} (+https://github.com/DuskXi/ArkRecord-Web)"


def default_upstreams_path() -> Path:
    """开发时在仓库里；打包后的位置由 ARKRECORD_SHARED_DIR 指定（M4）。"""
    shared = os.environ.get("ARKRECORD_SHARED_DIR")
    base = Path(shared) if shared else Path(__file__).resolve().parents[3] / "shared"
    return base / "upstreams" / "hg.json"


def load_upstreams(path: Path | None = None) -> dict[str, Any]:
    data = json.loads((path or default_upstreams_path()).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("hg.json 的格式不对")
    for name, upstream in data.items():
        routes = upstream.get("routes") if isinstance(upstream, dict) else None
        if not isinstance(upstream.get("host"), str) or not isinstance(routes, list) or not routes:
            raise ValueError(f"hg.json 里的 {name} 格式不对")
        for route in routes:
            if route.get("method") not in ("GET", "POST") or not str(route.get("path", "")).startswith("/"):
                raise ValueError(f"hg.json 里 {name} 的路由格式不对")
    return data


@dataclass
class UpstreamResponse:
    status: int
    headers: list[tuple[str, str]]
    body: bytes


# (method, url, headers, body, timeout) -> UpstreamResponse；测试时替换成假的上游
Sender = Callable[[str, str, Mapping[str, str], bytes | None, float], UpstreamResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_send(
    method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float
) -> UpstreamResponse:
    # 地址只会是白名单里的 https 地址（HgClient.request 拼出来的）
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)  # noqa: S310
    try:
        response = _opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        # 4xx、5xx 和没有跟随的重定向：照样把状态码和内容交给页面
        response = error
    with response:
        data = response.read(MAX_RESPONSE_BYTES + 1)
        if len(data) > MAX_RESPONSE_BYTES:
            raise OSError("上游响应太大")
        return UpstreamResponse(response.status, list(response.headers.items()), data)


def form_encode(value: str) -> str:
    """和浏览器的 URLSearchParams 相同的编码（application/x-www-form-urlencoded）。"""
    out = []
    for byte in value.encode("utf-8"):
        char = chr(byte)
        if char.isascii() and (char.isalnum() or char in "*-._"):
            out.append(char)
        elif char == " ":
            out.append("+")
        else:
            out.append(f"%{byte:02X}")
    return "".join(out)


def parse_envelope(text: str, method: str) -> dict[str, Any] | None:
    """校验请求信封；不合法时返回 None（规则同 worker/proxy.ts 的 parseEnvelope）。"""
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, dict) or not set(value) <= _ENVELOPE_KEYS:
        return None
    query = value.get("query", {})
    if not isinstance(query, dict) or len(query) > MAX_QUERY_PARAMS:
        return None
    for key, item in query.items():
        if not _QUERY_KEY_RE.match(key) or not isinstance(item, str) or len(item) > MAX_QUERY_VALUE:
            return None
    body = value.get("body")
    if method == "GET" and "body" in value:
        return None
    if method == "POST" and not isinstance(body, dict):
        return None
    role_token = value.get("roleToken")
    if "roleToken" in value and (not isinstance(role_token, str) or not _ROLE_TOKEN_RE.match(role_token)):
        return None
    ak_cookie = value.get("akCookie")
    if "akCookie" in value and (not isinstance(ak_cookie, str) or not _COOKIE_VALUE_RE.match(ak_cookie)):
        return None
    return value


def _proxy_error(status: int, code: str) -> dict[str, Any]:
    return {
        "status": status,
        "headers": {"content-type": "application/json", PROXY_HEADER: code},
        "body": json.dumps({"proxy": code}, separators=(",", ":")),
    }


def _ak_cookie(headers: list[tuple[str, str]]) -> str | None:
    for name, value in headers:
        if name.lower() != "set-cookie":
            continue
        pair = value.split(";", 1)[0]
        key, sep, cookie = pair.partition("=")
        if sep and key.strip() == AK_COOKIE_NAME:
            cookie = cookie.strip()
            return cookie if _COOKIE_VALUE_RE.match(cookie) else None
    return None


class HgClient:
    def __init__(self, upstreams: dict[str, Any] | None = None, send: Sender = urllib_send) -> None:
        self._upstreams = upstreams if upstreams is not None else load_upstreams()
        self._send = send

    def request(self, params: Params) -> dict[str, Any]:
        """RPC 方法 hg.request：params 是 {upstream, path, envelope}，返回 {status, headers, body}。"""
        if not isinstance(params, dict) or set(params) != {"upstream", "path", "envelope"}:
            raise RpcError(INVALID_PARAMS, "参数应为 {upstream, path, envelope}")
        name, path, envelope_text = params["upstream"], params["path"], params["envelope"]
        if not all(isinstance(v, str) for v in (name, path, envelope_text)):
            raise RpcError(INVALID_PARAMS, "upstream、path、envelope 都应为字符串")

        upstream = self._upstreams.get(name)
        route = next((r for r in upstream["routes"] if r["path"] == path), None) if upstream else None
        if upstream is None or route is None:
            return _proxy_error(404, "route_not_allowed")
        if len(envelope_text.encode("utf-8")) > MAX_BODY_BYTES:
            return _proxy_error(413, "body_too_large")
        envelope = parse_envelope(envelope_text, route["method"])
        if envelope is None:
            return _proxy_error(400, "bad_request")

        query = "&".join(f"{form_encode(k)}={form_encode(v)}" for k, v in envelope.get("query", {}).items())
        url = f"https://{upstream['host']}{route['path']}{'?' + query if query else ''}"
        headers = {"accept": "application/json", "accept-language": "zh-CN,zh;q=0.9", "user-agent": USER_AGENT}
        body = None
        if route["method"] == "POST":
            headers["content-type"] = "application/json"
            body = json.dumps(envelope["body"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if "roleToken" in envelope:
            headers["x-role-token"] = envelope["roleToken"]
        headers.update(upstream.get("extraHeaders") or {})
        if upstream.get("relayAkCookie") and "akCookie" in envelope:
            headers["cookie"] = f"{AK_COOKIE_NAME}={envelope['akCookie']}"

        started = time.monotonic()
        try:
            response = self._send(route["method"], url, headers, body, UPSTREAM_TIMEOUT_S)
        except Exception as error:
            # 不记录错误详情：其中可能有带 token 的地址
            log.warning("请求 %s %s 失败：%s", name, path, type(error).__name__)
            return _proxy_error(502, "upstream_unreachable")
        log.info("%s %s → %s（%d ms）", name, path, response.status, (time.monotonic() - started) * 1000)

        result_headers: dict[str, str] = {}
        content_type = next((v for k, v in response.headers if k.lower() == "content-type"), None)
        if content_type is not None:
            result_headers["content-type"] = content_type
        if upstream.get("relayAkCookie"):
            cookie = _ak_cookie(response.headers)
            if cookie is not None:
                result_headers[AK_COOKIE_HEADER] = cookie
        return {
            "status": response.status,
            "headers": result_headers,
            "body": response.body.decode("utf-8", errors="replace"),
        }
