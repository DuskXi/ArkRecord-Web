"""桌面版的角色 / 武器图标，按名称查 BWIKI。

维护者 2026-10-20：原神、星铁“还是用bwiki的图吧，并且软件声明不拥有图片版权”；之后明日方舟、终末地也
“本地全走转发限速这条路”：桌面版不打包镜像的头像，运行时由本机按需加载（明日方舟走 PRTS，见 images.py）。

wiki.icons {game, names} → {items: {名称: target}, complete}；game 是 genshin、starrail、endfield。
mhy.icons 是同一个方法，只接受原神、星铁（米哈游页面在用）。
- 原神（wiki.biligame.com/ys）、星铁（/sr）查“文件:<名称>.png”；终末地（/zmd）查“文件:<名称>头像.png”，
  没有时用“文件:<名称>图标.png”（部分武器只有图标），名称去掉空格和下划线也试一次（和构建脚本
  scripts/sync-gamedata.mjs 的 normalizeName 一致）。用 MediaWiki 接口的 imageinfo 查图片地址，一次最多 50 个标题；
  只查页面给的名称，不拉整个分类。
- target 是图片在 patchwiki.biligame.com 上的路径（images/ys/...），页面用 /api/img/bwiki/<target> 显示，
  由 img.fetch 按桌面版专用的白名单拉取、缓存（images.py 的 DESKTOP_SOURCES）。
- 查到的 30 天内不再查，没有的 1 天后再查。对 BWIKI 低频（bili.py）：同一时间一个请求，两次之间至少 8 秒，
  一次调用最多 2 个请求；出错（包括 B 站反爬的 HTTP 567）后和图片下载一起退避，退避期间只返回缓存，不重试。
- 结果缓存在 ARKRECORD_DATA_DIR/wiki-icons/<game>.json（以前原神、星铁的在 mhy-icons/，读得到就沿用），
  不进仓库、不经过 Worker。图片的版权归各游戏公司，“关于”页有声明。
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

from . import __version__
from .bili import BiliGuard
from .hg import Sender, urllib_send
from .images import BWIKI_HOST, BWIKI_TARGET
from .rpc import INVALID_PARAMS, Params, RpcError

log = logging.getLogger(__name__)

API_HOST = "wiki.biligame.com"
# 每个游戏：哪个 wiki、文件名的后缀（按顺序试，前面的优先）、要不要试去掉空格和下划线的名称
GAMES: dict[str, dict[str, Any]] = {
    "genshin": {"wiki": "ys", "suffixes": (".png",), "variants": False},
    "starrail": {"wiki": "sr", "suffixes": (".png",), "variants": False},
    "endfield": {"wiki": "zmd", "suffixes": ("头像.png", "图标.png"), "variants": True},
}
MHY_GAMES = ("genshin", "starrail")
USER_AGENT = f"ArkRecord-Desktop/{__version__} (+https://github.com/DuskXi/ArkRecord-Web)"

# 一次请求最多 50 个标题；一次调用最多 2 次请求，其余的下次再查（complete 为 false）
BATCH = 50
MAX_REQUESTS_PER_CALL = 2
MAX_NAMES = 1000
TIMEOUT_S = 15
FOUND_TTL_S = 30 * 24 * 3600
MISSING_TTL_S = 24 * 3600
# 日志里最多列出多少个没查到的名称（都是公开的角色 / 武器名）
LOG_MISSING = 30
# 图标都在 300 KB 以内；更大的多半是立绘，不用
MAX_ICON_BYTES = 1024 * 1024
CACHE_DIR = "wiki-icons"
OLD_CACHE_DIR = "mhy-icons"
CACHE_VERSION = 1

# 名称里不能有 MediaWiki 标题不允许的字符（| 还是批量查询的分隔符）
_NAME = re.compile(r"[^#<>\[\]{}|\x00-\x1f\x7f]{1,40}")
_TARGET = re.compile(BWIKI_TARGET, re.ASCII)


class _Failure(Exception):
    pass


def normalize_name(name: str) -> str:
    """和 scripts/sync-gamedata.mjs 的 normalizeName 一致：去掉下划线和空格。"""
    return name.replace("_", "").replace(" ", "")


class WikiIcons:
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
        self._game_locks = {game: threading.Lock() for game in GAMES}
        # 没有数据目录时（测试、开发）只放在内存里
        self._memory: dict[str, dict[str, Any]] = {}

    # ---- 缓存 ----

    def _path(self, game: str) -> Path | None:
        return self._dir / CACHE_DIR / f"{game}.json" if self._dir else None

    def _load(self, game: str) -> dict[str, Any]:
        path = self._path(game)
        if path is None or self._dir is None:
            return self._memory.setdefault(game, {"version": CACHE_VERSION, "items": {}})
        for candidate in (path, self._dir / OLD_CACHE_DIR / f"{game}.json"):
            try:
                state = json.loads(candidate.read_text(encoding="utf-8"))
                if state.get("version") == CACHE_VERSION and isinstance(state.get("items"), dict):
                    return state
            except (OSError, ValueError, AttributeError):
                continue
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

    @staticmethod
    def _titles(game: str, name: str) -> list[str]:
        """一个名称要试的文件标题，前面的优先。"""
        config = GAMES[game]
        variants = [name]
        if config["variants"] and normalize_name(name) not in variants:
            variants.append(normalize_name(name))
        return [f"文件:{v}{suffix}" for suffix in config["suffixes"] for v in variants]

    def _batches(self, game: str, names: list[str]) -> list[list[str]]:
        """把名称分成每次请求的一批（每批的标题不超过 BATCH 个）。"""
        batches: list[list[str]] = [[]]
        size = 0
        for name in names:
            count = len(self._titles(game, name))
            if batches[-1] and size + count > BATCH:
                batches.append([])
                size = 0
            batches[-1].append(name)
            size += count
        return [b for b in batches if b]

    def _query(self, game: str, names: list[str]) -> dict[str, str | None]:
        """查一批名称的图标；返回 名称 → target（没有图标时为 None）。出错时抛 _Failure。"""
        wiki = GAMES[game]["wiki"]
        wanted = {name: self._titles(game, name) for name in names}
        titles = list(dict.fromkeys(t for ts in wanted.values() for t in ts))
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

        def target_of(title: str) -> str | None:
            final = title
            for _ in range(3):
                final = renamed.get(final, final)
            return self._target(wiki, pages.get(final))

        return {name: next((t for t in map(target_of, ts) if t), None) for name, ts in wanted.items()}

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

    def icons(self, params: Params, games: tuple[str, ...] = tuple(GAMES)) -> dict[str, Any]:
        if not isinstance(params, dict) or set(params) != {"game", "names"}:
            raise RpcError(INVALID_PARAMS, "参数应为 {game, names}")
        game, names = params["game"], params["names"]
        if game not in games:
            raise RpcError(INVALID_PARAMS, f"game 应为 {'、'.join(games)} 之一")
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
                    for batch in self._batches(game, due)[:MAX_REQUESTS_PER_CALL]:
                        found = self._query(game, batch)
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
        return {
            "wiki.icons": self.icons,
            # 米哈游页面原来用的名字，只接受原神、星铁
            "mhy.icons": lambda params: self.icons(params, MHY_GAMES),
        }
