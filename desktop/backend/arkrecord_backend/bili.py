"""对 B 站（BWIKI）的请求节奏和退避：接口 wiki.biligame.com、图片 patchwiki.biligame.com。

2026-10-20 维护者本机实测：星铁查了 3 次接口、下了几十张图之后，原神的第 1 次接口请求就被 B 站的反爬拦下（HTTP 567）。
两个域名可能是同一套防护（推测，没有核实），所以：
- 两边共用一个“被拦下了”的状态：任何一边遇到 567（或 429），接口和图片一起退避，15 分钟起每次翻倍、最多 1 天；
  记在 ARKRECORD_DATA_DIR/bili-guard.json，重启后也遵守。退避期间不发请求，接口返回缓存、图片返回 502。
- 接口：同一时间一个请求，两次之间至少 API_INTERVAL_S 秒。
- 图片：同时最多 IMAGE_CONCURRENCY 张，两次开始之间至少 IMAGE_INTERVAL_S 秒。
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path

log = logging.getLogger(__name__)

API_INTERVAL_S = 8.0
IMAGE_CONCURRENCY = 2
IMAGE_INTERVAL_S = 0.2
BACKOFF_START_S = 15 * 60
BACKOFF_MAX_S = 24 * 3600
STATE_FILE = "bili-guard.json"
# B 站的反爬（567）和通用的“太多请求”
BLOCK_STATUSES = frozenset({429, 567})


class BiliGuard:
    def __init__(
        self,
        data_dir: Path | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        env_dir = os.environ.get("ARKRECORD_DATA_DIR")
        self._dir = data_dir or (Path(env_dir) if env_dir else None)
        self._clock = clock
        self._sleep = sleep
        self._state_lock = threading.Lock()
        self._count = 0
        self._until = 0.0
        self._load()
        self._api_lock = threading.Lock()
        self._api_last = -API_INTERVAL_S
        self._image_slots = threading.Semaphore(IMAGE_CONCURRENCY)
        self._image_lock = threading.Lock()
        self._image_last = -IMAGE_INTERVAL_S

    # ---- 退避 ----

    def _path(self) -> Path | None:
        return self._dir / STATE_FILE if self._dir else None

    def _load(self) -> None:
        path = self._path()
        if path is None or not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self._count = max(0, int(data.get("count", 0)))
            self._until = float(data.get("until", 0))
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    def _save(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps({"count": self._count, "until": self._until}), encoding="utf-8")
            temp.replace(path)
        except OSError as error:
            log.warning("写 B 站退避状态失败：%s", type(error).__name__)

    def blocked(self) -> bool:
        with self._state_lock:
            return self._clock() < self._until

    def report_block(self) -> None:
        """被拦下了（或者接口出错）：两边一起退避。"""
        with self._state_lock:
            if self._clock() < self._until:
                return
            self._count += 1
            wait = min(BACKOFF_MAX_S, BACKOFF_START_S * 2 ** (self._count - 1))
            self._until = self._clock() + wait
            log.info("BWIKI 暂停请求 %d 分钟（第 %d 次）", wait // 60, self._count)
            self._save()

    def report_ok(self) -> None:
        with self._state_lock:
            if self._count:
                self._count = 0
                self._until = 0.0
                self._save()

    # ---- 节奏 ----

    @contextlib.contextmanager
    def api_turn(self) -> Iterator[None]:
        """接口请求：同一时间一个，两次之间至少 API_INTERVAL_S 秒。"""
        with self._api_lock:
            wait = self._api_last + API_INTERVAL_S - self._clock()
            if wait > 0:
                self._sleep(wait)
            try:
                yield
            finally:
                self._api_last = self._clock()

    @contextlib.contextmanager
    def image_turn(self) -> Iterator[None]:
        """图片下载：同时最多 IMAGE_CONCURRENCY 张，两次开始之间至少 IMAGE_INTERVAL_S 秒。"""
        with self._image_slots:
            with self._image_lock:
                wait = self._image_last + IMAGE_INTERVAL_S - self._clock()
                if wait > 0:
                    self._sleep(wait)
                self._image_last = self._clock()
            yield
