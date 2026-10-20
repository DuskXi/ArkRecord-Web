"""桌面版的图片（维护者 2026-10-19：“本地这边的图片，采取python转发，也不用走worker了”）。

页面照旧请求 /api/img/<来源>/<路径>，主进程把这类请求交给这里（img.fetch）。规则和 Worker 一致（worker/images.ts）：
- 只拉白名单里的图片，路径必须完整匹配：shared/images.json（和 Worker 同一份）加上桌面版专用的 DESKTOP_SOURCES；
- 不跟随重定向，只接受 image/* 且不超过 5 MB；
- 缓存在应用数据目录（ARKRECORD_DATA_DIR/image-cache），成功的 30 天，来源站 404 的 1 小时。
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import __version__
from .hg import Sender, shared_dir, urllib_send
from .rpc import INVALID_PARAMS, Params, RpcError

log = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 5 * 1024 * 1024
TIMEOUT_S = 15
CACHE_SECONDS = 30 * 24 * 3600
MISSING_SECONDS = 3600
CACHE_DIR = "image-cache"

# 原神、星铁的图标（BWIKI，mhy/icons.py 查出路径）：images/<ys|sr>/<哈希目录>/<文件名>，不带缩略图和查询参数
BWIKI_HOST = "patchwiki.biligame.com"
BWIKI_TARGET = r"images/(?:ys|sr)/[0-9a-f]/[0-9a-f]{2}/[0-9a-z]{16,48}\.(?:png|jpe?g|webp|gif)"

# 只在桌面版用的来源：不放进 shared/images.json，Worker 不转发这些
DESKTOP_SOURCES: dict[str, dict[str, str]] = {
    "bwiki": {
        "host": BWIKI_HOST,
        "purpose": "原神、星铁的角色 / 武器 / 光锥图标（BWIKI，维护者 2026-10-20 选定；版权归米哈游，“关于”页有声明）",
        "pattern": f"^{BWIKI_TARGET}$",
        "path": "/{target}",
    },
}


def load_sources(path: Path | None = None, desktop: bool = True) -> dict[str, dict[str, Any]]:
    data = json.loads((path or shared_dir() / "images.json").read_text(encoding="utf-8"))
    if desktop:
        data = {**data, **DESKTOP_SOURCES}
    sources = {}
    for name, source in data.items():
        if not isinstance(source.get("host"), str) or "{target}" not in source.get("path", ""):
            raise ValueError(f"images.json 里的 {name} 格式不对")
        # 和 JS 的正则一致：\\w 只算 ASCII
        sources[name] = {**source, "regex": re.compile(source["pattern"], re.ASCII)}
    return sources


class Images:
    def __init__(
        self,
        sources: dict[str, dict[str, Any]] | None = None,
        data_dir: Path | None = None,
        send: Sender = urllib_send,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._sources = sources
        env_dir = os.environ.get("ARKRECORD_DATA_DIR")
        self._dir = data_dir or (Path(env_dir) if env_dir else None)
        self._send = send
        self._clock = clock

    @property
    def sources(self) -> dict[str, dict[str, Any]]:
        if self._sources is None:
            self._sources = load_sources()
        return self._sources

    def resolve(self, source: str, target: str) -> str | None:
        """白名单内的来源站地址；不在白名单内时返回 None。"""
        config = self.sources.get(source)
        if config is None or not config["regex"].fullmatch(target):
            return None
        return f"https://{config['host']}{config['path'].replace('{target}', target)}"

    # ---- 缓存 ----

    def _cache_paths(self, url: str) -> tuple[Path, Path] | None:
        if not self._dir:
            return None
        key = hashlib.sha256(url.encode()).hexdigest()
        base = self._dir / CACHE_DIR
        return base / f"{key}.json", base / f"{key}.bin"

    def _read_cache(self, url: str) -> dict[str, Any] | None:
        paths = self._cache_paths(url)
        if not paths or not paths[0].is_file():
            return None
        try:
            meta = json.loads(paths[0].read_text(encoding="utf-8"))
            ttl = CACHE_SECONDS if meta["status"] == 200 else MISSING_SECONDS
            if self._clock() - meta["fetchedAt"] > ttl:
                return None
            if meta["status"] != 200:
                return {"status": meta["status"]}
            body = paths[1].read_bytes()
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return {"status": 200, "contentType": meta["contentType"], "body": base64.b64encode(body).decode()}

    def _write_cache(self, url: str, status: int, content_type: str | None = None, body: bytes = b"") -> None:
        paths = self._cache_paths(url)
        if not paths:
            return
        meta_path, body_path = paths
        try:
            meta_path.parent.mkdir(parents=True, exist_ok=True)
            if status == 200:
                temp = body_path.with_suffix(".tmp")
                temp.write_bytes(body)
                temp.replace(body_path)
            meta = {"status": status, "contentType": content_type, "fetchedAt": self._clock()}
            temp = meta_path.with_suffix(".jtmp")
            temp.write_text(json.dumps(meta), encoding="utf-8")
            temp.replace(meta_path)
        except OSError as error:
            log.warning("写图片缓存失败：%s", type(error).__name__)

    # ---- RPC ----

    def fetch(self, params: Params) -> dict[str, Any]:
        """img.fetch {source, target} → {status, contentType?, body?（base64）}。

        status 200 才有图片；404 是不在白名单里或者来源站没有；502 是来源站出错或返回的不是图片。
        """
        if not isinstance(params, dict) or set(params) != {"source", "target"}:
            raise RpcError(INVALID_PARAMS, "参数应为 {source, target}")
        source, target = params["source"], params["target"]
        if not isinstance(source, str) or not isinstance(target, str):
            raise RpcError(INVALID_PARAMS, "source、target 都应为字符串")
        url = self.resolve(source, target)
        if url is None:
            return {"status": 404}
        cached = self._read_cache(url)
        if cached:
            return cached

        headers = {
            "accept": "image/avif,image/webp,image/png,image/*;q=0.8",
            "user-agent": f"ArkRecord-Desktop/{__version__} (+https://github.com/DuskXi/ArkRecord-Web)",
        }
        try:
            response = self._send("GET", url, headers, None, TIMEOUT_S)
        except Exception as error:
            log.info("拉取图片失败（%s）：%s", source, type(error).__name__)
            return {"status": 502}
        if response.status == 404:
            self._write_cache(url, 404)
            return {"status": 404}
        content_type = next((v for k, v in response.headers if k.lower() == "content-type"), "")
        if response.status != 200 or not content_type.startswith("image/") or len(response.body) > MAX_IMAGE_BYTES:
            log.info("图片来源站返回的内容不对（%s）：HTTP %s", source, response.status)
            return {"status": 502}
        self._write_cache(url, 200, content_type, response.body)
        return {"status": 200, "contentType": content_type, "body": base64.b64encode(response.body).decode()}

    def methods(self) -> dict[str, Any]:
        return {"img.fetch": self.fetch}
