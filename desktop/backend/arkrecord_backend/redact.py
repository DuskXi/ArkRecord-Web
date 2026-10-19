"""日志脱敏：凭据的值一律换成 ***。

凭据包括鹰角 token、角色 token、ak-user-center Cookie、抽卡链接里的 authkey 等。
所有日志都经过 RedactingFormatter；需要把数据写进日志时，先用 redact_value。
"""

from __future__ import annotations

import logging
import re
from typing import Any

MASK = "***"

# 键名去掉 - 和 _、转成小写后，包含下面任一片段就当作凭据（宁可多遮）
_SENSITIVE_PARTS = (
    "token",
    "cookie",
    "authkey",
    "ticket",
    "password",
    "secret",
    "credential",
    "authorization",
    "akusercenter",
    "sign",
)

# 出现在文本里的凭据：查询参数、Cookie、表单（key=value），以及 JSON（"key": "value"）
_WORDS = "token|cookie|authkey|ticket|password|secret|credential|authorization|ak-user-center|sign"
_KEY = rf"[A-Za-z0-9_\-]*(?:{_WORDS})[A-Za-z0-9_\-]*"
_KV_RE = re.compile(rf"(?i)(\b{_KEY}=)[^&;,\s\"'<>]+")
_JSON_RE = re.compile(rf"(?i)(\"{_KEY}\"\s*:\s*\")(?:[^\"\\]|\\.)*(\")")
_BEARER_RE = re.compile(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=\-]+")


def is_sensitive_key(key: str) -> bool:
    normalized = key.replace("-", "").replace("_", "").lower()
    return any(part in normalized for part in _SENSITIVE_PARTS)


def redact_text(text: str) -> str:
    text = _JSON_RE.sub(rf"\g<1>{MASK}\g<2>", text)
    text = _KV_RE.sub(rf"\g<1>{MASK}", text)
    return _BEARER_RE.sub(rf"\g<1>{MASK}", text)


def redact_value(value: Any) -> Any:
    """返回脱敏后的副本：字典里凭据键的值换成 ***，字符串按 redact_text 处理。"""
    if isinstance(value, dict):
        return {k: (MASK if isinstance(k, str) and is_sensitive_key(k) else redact_value(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact_value(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


class RedactingFormatter(logging.Formatter):
    """格式化后（含异常堆栈）再整体脱敏。"""

    def format(self, record: logging.LogRecord) -> str:
        return redact_text(super().format(record))
