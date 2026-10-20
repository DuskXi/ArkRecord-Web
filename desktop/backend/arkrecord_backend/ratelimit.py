"""本机对外请求的每分钟次数上限（维护者 2026-10-20：“对云请求本身就要有rpm本地限制”）。

后端所有对外请求都经过 hg.urllib_send，在那里按主机取号：最近 60 秒内的请求数到了上限就排队等，不直接失败。
上限按主机（或域名后缀）配置，没有列出的主机用 DEFAULT_RPM。计数只在内存里，重启后从零开始；
B 站被拦下后的退避另有持久的记录（bili.py）。

各处还有自己的节奏，这里是最后一道保险：米哈游接口每个服务器两次至少隔 0.5 秒（mhy/gacha.py），
BWIKI 接口两次至少隔 8 秒、图片同时最多 2 张（bili.py）。
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence

log = logging.getLogger(__name__)

WINDOW_S = 60.0
# （主机，每分钟最多几次）；以“.”开头的是域名后缀。先找完全相同的主机，再找后缀
RPM_RULES: Sequence[tuple[str, int]] = (
    # BWIKI：接口最严（2026-10-20 实测被 B 站的反爬拦过），图片按页面一次要几十张算
    ("wiki.biligame.com", 6),
    ("patchwiki.biligame.com", 60),
    # 明日方舟头像（PRTS，桌面版运行时加载，一页可能有上百个干员）、终末地卡池图（鹰角 CDN）
    ("torappu.prts.wiki", 120),
    ("web.hycdn.cn", 60),
    # 米哈游的抽卡记录接口：读一个大账号要翻上百页
    (".mihoyo.com", 100),
    (".hoyoverse.com", 100),
    # 鹰角的接口：同步记录要翻很多页
    (".hypergryph.com", 120),
)
DEFAULT_RPM = 60


def rpm_for(host: str, rules: Sequence[tuple[str, int]] = RPM_RULES, default: int = DEFAULT_RPM) -> int:
    host = host.lower()
    for pattern, limit in rules:
        if not pattern.startswith(".") and host == pattern:
            return limit
    for pattern, limit in rules:
        if pattern.startswith(".") and host.endswith(pattern):
            return limit
    return default


class RateLimiter:
    def __init__(
        self,
        rules: Sequence[tuple[str, int]] = RPM_RULES,
        default: int = DEFAULT_RPM,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        window: float = WINDOW_S,
    ) -> None:
        self._rules = rules
        self._default = default
        self._clock = clock
        self._sleep = sleep
        self._window = window
        self._lock = threading.Lock()
        self._hosts: dict[str, tuple[threading.Lock, deque[float]]] = {}

    def acquire(self, host: str) -> float:
        """取一个号：到了上限就等到最早的那次请求滑出窗口。返回等了多少秒。"""
        with self._lock:
            lock, times = self._hosts.setdefault(host.lower(), (threading.Lock(), deque()))
        limit = max(1, rpm_for(host, self._rules, self._default))
        waited = 0.0
        # 同一个主机的请求排队取号（拿着锁等，先来的先走）
        with lock:
            while True:
                now = self._clock()
                while times and times[0] <= now - self._window:
                    times.popleft()
                if len(times) < limit:
                    times.append(now)
                    return waited
                wait = times[0] + self._window - now
                if waited == 0:
                    log.info("%s 每分钟最多 %d 次，排队 %.1f 秒", host, limit, wait)
                self._sleep(wait)
                waited += wait


# 后端里所有真实的对外请求共用这一个（hg.urllib_send）
LIMITER = RateLimiter()
