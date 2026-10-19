"""米哈游的 RPC 方法（协议见 desktop/README.md）。

抽卡链接（含 authkey）只留在本进程内存里；页面拿到的是随机句柄，拉记录时传句柄。
"""

from __future__ import annotations

import logging
import re
import secrets
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from ..rpc import INVALID_PARAMS, AppError, Params, RpcError
from .cache import cache_files, gacha_urls, read_cache, version_dirs
from .gacha import MAX_PAGE_SIZE, GachaApi
from .games import GAMES, Game
from .link import GachaLink, parse_link
from .locate import find_data_dirs, log_paths, resolve_data_dir

log = logging.getLogger(__name__)

# 最多校验这么多条候选链接（每条要发一次请求）
MAX_CANDIDATES = 5
MAX_HANDLES = 8
END_ID_RE = re.compile(r"^\d{1,24}$")


def _params(params: Params, required: set[str], optional: frozenset[str] | set[str] = frozenset()) -> dict[str, Any]:
    if not isinstance(params, dict) or not required <= set(params) <= required | optional:
        names = "、".join(sorted(required | optional))
        raise RpcError(INVALID_PARAMS, f"参数应为 {{{names}}}")
    return params


def _game(value: Any) -> Game:
    game = GAMES.get(value) if isinstance(value, str) else None
    if game is None:
        raise RpcError(INVALID_PARAMS, "game 只能是 genshin 或 starrail")
    return game


class MhyService:
    def __init__(self, api: GachaApi | None = None, home: Path | None = None) -> None:
        self._api = api
        self._home = home
        self._handles: OrderedDict[str, GachaLink] = OrderedDict()
        self._lock = threading.Lock()

    @property
    def api(self) -> GachaApi:
        # 第一次用到时才读白名单文件：文件有问题也不影响其他方法
        with self._lock:
            if self._api is None:
                self._api = GachaApi()
            return self._api

    def _home_dir(self) -> Path:
        return self._home or Path.home()

    def _data_dirs(self, game: Game, chosen: Any) -> list[Path]:
        if chosen is not None:
            if not isinstance(chosen, str) or not chosen:
                raise RpcError(INVALID_PARAMS, "dataDir 应为目录路径")
            path = resolve_data_dir(Path(chosen), game)
            if path is None:
                raise AppError("game_not_found", "选择的目录里没有找到游戏的网页缓存（webCaches）")
            return [path]
        _, dirs = find_data_dirs(game, self._home_dir())
        if not dirs:
            raise AppError("game_not_found", "没有找到游戏目录：请先启动一次游戏，或者手动选择游戏目录")
        return dirs

    def _store(self, link: GachaLink) -> str:
        handle = secrets.token_urlsafe(18)
        with self._lock:
            self._handles[handle] = link
            while len(self._handles) > MAX_HANDLES:
                self._handles.popitem(last=False)
        return handle

    def _link(self, handle: Any) -> GachaLink:
        with self._lock:
            link = self._handles.get(handle) if isinstance(handle, str) else None
        if link is None:
            raise AppError("handle_expired", "抽卡链接已失效，请重新读取")
        return link

    def _validate(self, link: GachaLink) -> dict[str, Any]:
        data = self.api.fetch_page(link, link.game.standard_gacha_type, "0", 1)
        first = data["list"][0] if data["list"] and isinstance(data["list"][0], dict) else {}
        uid = first.get("uid")
        return {
            "handle": self._store(link),
            "game": link.game.id,
            "gameBiz": link.game_biz,
            "region": data.get("region") or link.param("region"),
            "uid": uid if isinstance(uid, str) else None,
        }

    # ---- RPC 方法 ----

    def locate(self, params: Params) -> dict[str, Any]:
        """mhy.locate {game} → 找到的日志和游戏数据目录（不读缓存、不发请求）。"""
        game = _game(_params(params, {"game"})["game"])
        home = self._home_dir()
        logs, dirs = find_data_dirs(game, home)
        return {
            "logs": [str(path) for path in logs],
            "searched": [str(path) for path in log_paths(game, home)],
            "dataDirs": [{"path": str(d), "versions": [v.name for v in version_dirs(d)]} for d in dirs],
        }

    def cache_stamp(self, params: Params) -> dict[str, Any]:
        """mhy.cacheStamp {game, dataDir?} → 最新的 data_2 修改时间。“等待读取”时轮询它，变了再调 readCache。"""
        p = _params(params, {"game"}, {"dataDir"})
        game = _game(p["game"])
        stamps = [path.stat().st_mtime for d in self._data_dirs(game, p.get("dataDir")) for path in cache_files(d)]
        return {"mtime": max(stamps) if stamps else None}

    def find_links(self, game: Game, chosen: Any = None) -> list[GachaLink]:
        """缓存里的抽卡链接（新的在前，按 authkey 去重），不发请求。readCache 和本机实验（probe.py）共用。"""
        candidates: list[GachaLink] = []
        seen: set[str] = set()
        for data_dir in self._data_dirs(game, chosen):
            for path in cache_files(data_dir):
                try:
                    data = read_cache(path)
                except OSError as error:
                    log.warning("读取缓存失败（%s）：%s", path.parent.parent.parent.name, type(error).__name__)
                    continue
                for url in gacha_urls(data):
                    link = parse_link(url)
                    key = link.param("authkey") if link else None
                    if link and link.game is game and key not in seen:
                        seen.add(key)
                        candidates.append(link)
        log.info("%s：缓存里找到 %d 条抽卡链接", game.id, len(candidates))
        return candidates

    def read_cache(self, params: Params) -> dict[str, Any]:
        """mhy.readCache {game, dataDir?} → 从缓存里找到并校验抽卡链接，返回句柄。"""
        p = _params(params, {"game"}, {"dataDir"})
        candidates = self.find_links(_game(p["game"]), p.get("dataDir"))
        if not candidates:
            raise AppError("no_link", "缓存里没有抽卡链接：请先在游戏里打开一次抽卡记录，再读取")
        for link in candidates[:MAX_CANDIDATES]:
            try:
                return {**self._validate(link), "source": "cache"}
            except AppError as error:
                if error.kind not in ("link_expired", "link_invalid"):
                    raise
        raise AppError("link_expired", "缓存里的抽卡链接都已过期：请在游戏里重新打开一次抽卡记录，再读取")

    def use_link(self, params: Params) -> dict[str, Any]:
        """mhy.useLink {url} → 校验用户粘贴的抽卡链接，返回句柄。"""
        url = _params(params, {"url"})["url"]
        link = parse_link(url) if isinstance(url, str) else None
        if link is None:
            raise AppError("bad_link", "不是原神或星铁的抽卡链接")
        return {**self._validate(link), "source": "pasted"}

    def fetch_page(self, params: Params) -> dict[str, Any]:
        """mhy.fetchPage {handle, gachaType, endId?, size?} → 一页记录（从新到旧）。"""
        p = _params(params, {"handle", "gachaType"}, {"endId", "size"})
        link = self._link(p["handle"])
        gacha_type, end_id, size = p["gachaType"], p.get("endId", "0"), p.get("size", MAX_PAGE_SIZE)
        if gacha_type not in link.game.gacha_types:
            raise RpcError(INVALID_PARAMS, "gachaType 不对")
        if not isinstance(end_id, str) or not END_ID_RE.match(end_id):
            raise RpcError(INVALID_PARAMS, "endId 应为数字字符串")
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_PAGE_SIZE:
            raise RpcError(INVALID_PARAMS, f"size 应为 1 到 {MAX_PAGE_SIZE}")
        data = self.api.fetch_page(link, gacha_type, end_id, size)
        return {"list": data["list"], "region": data.get("region"), "regionTimeZone": data.get("region_time_zone")}

    def forget(self, params: Params) -> dict[str, Any]:
        """mhy.forget {handle} → 丢掉这个链接。"""
        handle = _params(params, {"handle"})["handle"]
        if isinstance(handle, str):
            with self._lock:
                self._handles.pop(handle, None)
        return {"ok": True}

    def methods(self) -> dict[str, Any]:
        return {
            "mhy.locate": self.locate,
            "mhy.cacheStamp": self.cache_stamp,
            "mhy.readCache": self.read_cache,
            "mhy.useLink": self.use_link,
            "mhy.fetchPage": self.fetch_page,
            "mhy.forget": self.forget,
        }
