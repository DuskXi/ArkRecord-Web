"""B 站（BWIKI）的节奏和退避。"""

import threading
import time

from arkrecord_backend.bili import (
    API_INTERVAL_S,
    BACKOFF_MAX_S,
    BACKOFF_START_S,
    IMAGE_CONCURRENCY,
    BiliGuard,
)


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def test_backoff_doubles_up_to_a_day_and_resets_after_success(tmp_path):
    clock = Clock()
    guard = BiliGuard(tmp_path, clock, clock.sleep)
    waits = []
    for _ in range(9):
        guard.report_block()
        start = clock.now
        while guard.blocked():
            clock.now += 60
        waits.append(clock.now - start)
    assert waits[0] == BACKOFF_START_S
    assert waits[1] == 2 * BACKOFF_START_S
    assert waits[-1] == BACKOFF_MAX_S
    guard.report_ok()
    guard.report_block()
    assert BiliGuard(tmp_path, clock, clock.sleep).blocked()
    clock.now += BACKOFF_START_S
    assert not guard.blocked()


def test_blocks_reported_while_blocked_count_once(tmp_path):
    clock = Clock()
    guard = BiliGuard(tmp_path, clock, clock.sleep)
    guard.report_block()
    guard.report_block()
    clock.now += BACKOFF_START_S
    assert not guard.blocked()


def test_api_requests_are_spaced(tmp_path):
    clock = Clock()
    guard = BiliGuard(tmp_path, clock, clock.sleep)
    for _ in range(3):
        with guard.api_turn():
            pass
    assert clock.slept == [API_INTERVAL_S, API_INTERVAL_S]


def test_at_most_two_images_at_once(tmp_path):
    guard = BiliGuard(tmp_path)
    running = 0
    peak = 0
    lock = threading.Lock()

    def download():
        nonlocal running, peak
        with guard.image_turn():
            with lock:
                running += 1
                peak = max(peak, running)
            # 比两张图之间的间隔长，才会同时下载
            time.sleep(0.35)
            with lock:
                running -= 1

    threads = [threading.Thread(target=download) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak == IMAGE_CONCURRENCY
