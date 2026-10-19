"""直连米哈游官方接口拉取抽卡记录（不经过任何 Worker）。

- 只请求 shared/upstreams/mhy.json 白名单里的地址；
- 同一时间只发一个请求，两次请求之间至少间隔 MIN_INTERVAL_S（接口有限速，-110）；
- 日志只记接口、卡池、条数和 retcode，不记地址（地址里有 authkey）。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from ..hg import USER_AGENT, Sender, load_upstreams, shared_dir, urllib_send
from ..rpc import AppError
from .link import GachaLink

log = logging.getLogger(__name__)

MIN_INTERVAL_S = 0.5
TIMEOUT_S = 20
MAX_PAGE_SIZE = 20

RETCODE_EXPIRED = -101
RETCODE_INVALID = -100
RETCODE_TOO_FREQUENT = -110


def default_upstreams() -> dict[str, Any]:
    return load_upstreams(shared_dir() / "upstreams" / "mhy.json")


class GachaApi:
    def __init__(
        self,
        upstreams: dict[str, Any] | None = None,
        send: Sender = urllib_send,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._upstreams = upstreams if upstreams is not None else default_upstreams()
        self._send = send
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.Lock()
        self._last = -MIN_INTERVAL_S

    def upstream_host(self, name: str) -> str | None:
        """白名单里这个服务器的域名（本机实验列出会发什么请求时用）。"""
        upstream = self._upstreams.get(name)
        return upstream["host"] if upstream else None

    def path_for(self, link: GachaLink, gacha_type: str) -> str:
        if link.game.biz == "hk4e":
            return "/gacha_info/api/getGachaLog"
        endpoint = "getLdGachaLog" if gacha_type in link.game.ld_gacha_types else "getGachaLog"
        return f"/common/{link.api_base}/api/{endpoint}"

    def fetch_page(
        self, link: GachaLink, gacha_type: str, end_id: str = "0", size: int = MAX_PAGE_SIZE
    ) -> dict[str, Any]:
        """拉一页，返回接口的 data（list、region、region_time_zone 等）。出错时抛 AppError。"""
        upstream = self._upstreams.get(link.upstream)
        path = self.path_for(link, gacha_type)
        if upstream is None or not any(route["path"] == path for route in upstream["routes"]):
            raise AppError("unsupported", "不支持这个服务器的抽卡链接")
        query = [*link.params, ("gacha_type", gacha_type), ("page", "1"), ("size", str(size)), ("end_id", end_id)]
        url = f"https://{upstream['host']}{path}?" + "&".join(
            f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in query
        )
        headers = {"accept": "application/json", "user-agent": USER_AGENT}

        with self._lock:
            wait = self._last + MIN_INTERVAL_S - self._clock()
            if wait > 0:
                self._sleep(wait)
            try:
                response = self._send("GET", url, headers, None, TIMEOUT_S)
            except Exception as error:
                log.warning("请求 %s %s 失败：%s", link.upstream, path, type(error).__name__)
                raise AppError("network", "连不上米哈游的服务器，请检查网络后重试") from None
            finally:
                self._last = self._clock()

        if response.status != 200:
            log.warning("%s %s 卡池 %s → HTTP %s", link.upstream, path, gacha_type, response.status)
            raise AppError("upstream_error", f"米哈游的服务器返回了错误（HTTP {response.status}）")
        try:
            payload = json.loads(response.body)
        except ValueError:
            raise AppError("upstream_error", "米哈游的服务器返回的内容无法解析") from None
        retcode = payload.get("retcode") if isinstance(payload, dict) else None
        log.info("%s %s 卡池 %s → retcode %s", link.upstream, path, gacha_type, retcode)
        if retcode == RETCODE_EXPIRED:
            raise AppError("link_expired", "抽卡链接已过期：请在游戏里重新打开一次抽卡记录")
        if retcode == RETCODE_INVALID:
            raise AppError("link_invalid", "抽卡链接无效")
        if retcode == RETCODE_TOO_FREQUENT:
            raise AppError("rate_limited", "请求太频繁，请稍后再试")
        data = payload.get("data") if retcode == 0 else None
        if not isinstance(data, dict) or not isinstance(data.get("list"), list):
            raise AppError("upstream_error", f"米哈游的服务器返回了错误（retcode {retcode}）")
        return data
