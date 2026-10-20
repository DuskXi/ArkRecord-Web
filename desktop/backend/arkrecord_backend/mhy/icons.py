"""原神、星铁的角色 / 武器 / 光锥图标（维护者 2026-10-20：“还是用bwiki的图吧，并且软件声明不拥有图片版权”）。

mhy.icons {game, names} → {items: {名称: target}, complete}
- 图标是 BWIKI 上的“文件:<名称>.png”（原神 wiki.biligame.com/ys，星铁 /sr），用 MediaWiki 接口的 imageinfo
  查图片地址，一次最多 50 个；只查页面给的名称（记录里出现过的简体中文名），不拉整个分类。
- target 是图片在 patchwiki.biligame.com 上的路径（images/ys/...），页面用 /api/img/bwiki/<target> 显示，
  由 img.fetch 按桌面版专用的白名单拉取、缓存（images.py 的 DESKTOP_SOURCES）。
- 查到的 30 天内不再查，没有的 1 天后再查。对 BWIKI 低频（bili.py）：同一时间一个请求，两次之间至少 8 秒，
  一次调用最多 2 个请求；出错（包括 B 站反爬的 HTTP 567）后和图片下载一起退避，退避期间只返回缓存，不重试。
- 结果缓存在 ARKRECORD_DATA_DIR/mhy-icons/<game>.json，不进仓库、不经过 Worker。图片的版权归米哈游，
  “关于”页有声明。
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .. import __version__
from ..bili import BiliGuard
from ..hg import Sender, urllib_send
from ..images import BWIKI_HOST, BWIKI_TARGET
from ..rpc import INVALID_PARAMS, Params, RpcError

log = logging.getLogger(__name__)

API_HOST = "wiki.biligame.com"
WIKI = {"genshin": "ys", "starrail": "sr"}
USER_AGENT = f"ArkRecord-Desktop/{__version__} (+https://github.com/DuskXi/ArkRecord-Web)"

BATCH = 50
# 一次调用最多查多少个名称（2 次请求），其余的下次再查（complete 为 false）
MAX_LOOKUPS_PER_CALL = 100
MAX_NAMES = 1000
TIMEOUT_S = 15
FOUND_TTL_S = 30 * 24 * 3600
MISSING_TTL_S = 24 * 3600
# 日志里最多列出多少个没查到的名称（都是公开的角色 / 武器名）
LOG_MISSING = 30
# 图标都在 300 KB 以内；更大的多半是立绘，不用
MAX_ICON_BYTES = 1024 * 1024
CACHE_DIR = "mhy-icons"
CACHE_VERSION = 1

# 名称里不能有 MediaWiki 标题不允许的字符（| 还是批量查询的分隔符）
_NAME = re.compile(r"[^#<>\[\]{}|\x00-\x1f\x7f]{1,40}")
_TARGET = re.compile(BWIKI_TARGET, re.ASCII)


class _Failure(Exception):
    pass


class MhyIcons:
    def __init__(
        self,
        data_dir: Path | None = None,
        send: Sender = urllib_send,
        clock: Callable[[], float] = time.time,
        guard: BiliGuard | None = None,
    ) -> None:
        env_dir = os.environ.get("ARKRECORD_DATA_DIR")
        self._dir = data_dir or (Path(env_dir) if env_dir else None)
        self._send = send
        self._clock = clock
        # 节奏和退避和图片下载共用（两个 wiki、图片都是 B 站的）
        self._guard = guard or BiliGuard(self._dir, clock)
        self._game_locks = {game: threading.Lock() for game in WIKI}
        # 没有数据目录时（测试、开发）只放在内存里
        self._memory: dict[str, dict[str, Any]] = {}

    # ---- 缓存 ----

    def _path(self, game: str) -> Path | None:
        return self._dir / CACHE_DIR / f"{game}.json" if self._dir else None

    def _load(self, game: str) -> dict[str, Any]:
        path = self._path(game)
        if path is None:
            return self._memory.setdefault(game, {"version": CACHE_VERSION, "items": {}})
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("version") == CACHE_VERSION and isinstance(state.get("items"), dict):
                return state
        except (OSError, ValueError, AttributeError):
            pass
        return {"version": CACHE_VERSION, "items": {}}

    def _save(self, game: str, state: dict[str, Any]) -> None:
        path = self._path(game)
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            temp.replace(path)
        except OSError as error:
            log.warning("写图标缓存失败：%s", type(error).__name__)

    def _due(self, entry: Any, now: float) -> bool:
        if not isinstance(entry, dict) or not isinstance(entry.get("checkedAt"), int | float):
            return True
        ttl = FOUND_TTL_S if entry.get("target") else MISSING_TTL_S
        return now - entry["checkedAt"] > ttl

    # ---- BWIKI ----

    def _query(self, wiki: str, names: list[str]) -> dict[str, str | None]:
        """查一批名称的图标；返回 名称 → target（没有图标时为 None）。出错时抛 _Failure。"""
        titles = {f"文件:{name}.png": name for name in names}
        query = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "redirects": "1",
            "prop": "imageinfo",
            "iiprop": "url|size|mime",
            "titles": "|".join(titles),
        }
        url = f"https://{API_HOST}/{wiki}/api.php?" + "&".join(f"{k}={quote(v, safe='')}" for k, v in query.items())
        headers = {"accept": "application/json", "user-agent": USER_AGENT}
        with self._guard.api_turn():
            # 排队时另一个请求可能刚被拦下
            if self._guard.blocked():
                raise _Failure
            try:
                response = self._send("GET", url, headers, None, TIMEOUT_S)
            except Exception as error:
                log.info("查 BWIKI 图标失败：%s", type(error).__name__)
                raise _Failure from None
        if response.status != 200:
            # 567 是 B 站的反爬
            log.info("查 BWIKI 图标：HTTP %s", response.status)
            raise _Failure
        try:
            data = json.loads(response.body)
            result = data["query"]
        except (ValueError, KeyError, TypeError):
            log.info("BWIKI 返回的内容无法解析")
            raise _Failure from None

        renamed: dict[str, str] = {}
        for key in ("normalized", "redirects"):
            for item in result.get(key) or []:
                if isinstance(item, dict) and isinstance(item.get("from"), str) and isinstance(item.get("to"), str):
                    renamed[item["from"]] = item["to"]
        pages = {page.get("title"): page for page in result.get("pages") or [] if isinstance(page, dict)}

        out: dict[str, str | None] = {}
        for title, name in titles.items():
            final = title
            for _ in range(3):
                final = renamed.get(final, final)
            out[name] = self._target(wiki, pages.get(final))
        return out

    @staticmethod
    def _target(wiki: str, page: dict[str, Any] | None) -> str | None:
        info = (page or {}).get("imageinfo") or []
        if not info or not isinstance(info[0], dict):
            return None
        url, size, mime = info[0].get("url"), info[0].get("size"), info[0].get("mime")
        prefix = f"https://{BWIKI_HOST}/"
        if not isinstance(url, str) or not url.startswith(prefix):
            return None
        target = url[len(prefix) :]
        if not _TARGET.fullmatch(target) or not target.startswith(f"images/{wiki}/"):
            return None
        if not isinstance(size, int) or size > MAX_ICON_BYTES or not str(mime).startswith("image/"):
            return None
        return target

    # ---- RPC ----

    def icons(self, params: Params) -> dict[str, Any]:
        if not isinstance(params, dict) or set(params) != {"game", "names"}:
            raise RpcError(INVALID_PARAMS, "参数应为 {game, names}")
        game, names = params["game"], params["names"]
        if game not in WIKI:
            raise RpcError(INVALID_PARAMS, "game 应为 genshin 或 starrail")
        if not isinstance(names, list) or len(names) > MAX_NAMES or not all(isinstance(n, str) for n in names):
            raise RpcError(INVALID_PARAMS, f"names 应为字符串列表（最多 {MAX_NAMES} 个）")
        wanted = list(dict.fromkeys(n for n in names if _NAME.fullmatch(n)))

        with self._game_locks[game]:
            state = self._load(game)
            items: dict[str, Any] = state["items"]
            now = self._clock()
            due = [n for n in wanted if self._due(items.get(n), now)]
            if due and not self._guard.blocked():
                checked: list[str] = []
                missing: list[str] = []
                try:
                    for start in range(0, min(len(due), MAX_LOOKUPS_PER_CALL), BATCH):
                        batch = due[start : start + BATCH]
                        found = self._query(WIKI[game], batch)
                        stamp = self._clock()
                        for name in batch:
                            items[name] = {"target": found.get(name), "checkedAt": stamp}
                            (checked if found.get(name) else missing).append(name)
                    self._guard.report_ok()
                except _Failure:
                    self._guard.report_block()
                log.info(
                    "查 BWIKI 图标（%s）：查到 %d 个，没查到 %d 个，还剩 %d 个没查%s",
                    game,
                    len(checked),
                    len(missing),
                    len(due) - len(checked) - len(missing),
                    f"；没查到：{'、'.join(missing[:LOG_MISSING])}" if missing else "",
                )
                self._save(game, state)
                now = self._clock()
                due = [n for n in wanted if self._due(items.get(n), now)]

            found_items = {
                n: items[n]["target"] for n in wanted if isinstance(items.get(n), dict) and items[n].get("target")
            }
            return {"items": found_items, "complete": not due}

    def methods(self) -> dict[str, Any]:
        return {"mhy.icons": self.icons}
