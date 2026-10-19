"""stdio 上的 JSON-RPC 2.0：一行一个消息（UTF-8，\\n 分隔）。

- stdout 只输出协议消息；日志写到 stderr（经过脱敏）。
- 不支持批量请求（数组）。
- 通知（没有 id 的请求）不回复，出错也不回复。
- stdin 关闭（EOF）时 serve 返回，进程退出。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable, Mapping
from typing import Any, TextIO

log = logging.getLogger(__name__)

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
# 业务错误统一用这个码，error.data.kind 说明类型
APP_ERROR = -32000

Params = dict[str, Any] | list[Any] | None
Handler = Callable[[Params], Any]


class RpcError(Exception):
    def __init__(self, code: int, message: str, kind: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.kind = kind

    def to_json(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.kind:
            error["data"] = {"kind": self.kind}
        return error


class AppError(RpcError):
    """业务错误（如链接过期、找不到游戏目录）。message 会显示给用户，不能含凭据。"""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(APP_ERROR, message, kind)


def no_params(params: Params) -> None:
    """用于不接受参数的方法。"""
    if params not in (None, {}, []):
        raise RpcError(INVALID_PARAMS, "这个方法不接受参数")


def _valid_id(value: Any) -> bool:
    return value is None or isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool))


def _error(id_: Any, error: RpcError) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": error.to_json()}


def handle_line(line: str, methods: Mapping[str, Handler]) -> dict[str, Any] | None:
    """处理一行请求，返回要写回的响应；通知返回 None。"""
    try:
        message = json.loads(line)
    except ValueError:
        return _error(None, RpcError(PARSE_ERROR, "Parse error"))

    if not isinstance(message, dict):
        return _error(None, RpcError(INVALID_REQUEST, "Invalid Request"))

    is_notification = "id" not in message
    id_ = message.get("id")
    method = message.get("method")
    params = message.get("params")
    if (
        message.get("jsonrpc") != "2.0"
        or not isinstance(method, str)
        or not _valid_id(id_)
        or ("params" in message and not isinstance(params, dict | list))
    ):
        return _error(id_ if _valid_id(id_) else None, RpcError(INVALID_REQUEST, "Invalid Request"))

    handler = methods.get(method)
    try:
        if handler is None:
            raise RpcError(METHOD_NOT_FOUND, "Method not found")
        result = handler(params)
    except RpcError as error:
        return None if is_notification else _error(id_, error)
    except Exception:
        # 详细信息只进日志（已脱敏），不回给调用方
        log.exception("处理 %s 时出错", method)
        return None if is_notification else _error(id_, RpcError(INTERNAL_ERROR, "Internal error"))

    return None if is_notification else {"jsonrpc": "2.0", "id": id_, "result": result}


def encode(response: dict[str, Any]) -> str:
    return json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n"


def serve(methods: Mapping[str, Handler], lines: Iterable[str], out: TextIO) -> None:
    """逐行处理请求，直到输入结束。"""
    for raw in lines:
        # 去掉 BOM：Windows PowerShell 5.1 用管道传给后端时会在开头加 U+FEFF
        line = raw.strip().lstrip("\ufeff").strip()
        if not line:
            continue
        response = handle_line(line, methods)
        if response is not None:
            out.write(encode(response))
            out.flush()
