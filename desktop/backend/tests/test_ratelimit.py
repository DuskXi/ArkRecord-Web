"""每个主机每分钟的请求次数上限。"""

import threading

import pytest

from arkrecord_backend import hg
from arkrecord_backend.ratelimit import DEFAULT_RPM, LIMITER, RPM_RULES, RateLimiter, rpm_for


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


@pytest.mark.parametrize(
    ("host", "rpm"),
    [
        ("wiki.biligame.com", 6),
        ("patchwiki.biligame.com", 60),
        ("public-operation-hk4e.mihoyo.com", 100),
        ("public-operation-hkrpg-sg.hoyoverse.com", 100),
        ("as.hypergryph.com", 120),
        ("WIKI.BILIGAME.COM", 6),
        ("example.com", DEFAULT_RPM),
        # 只是名字里带后缀的不算
        ("evilmihoyo.com", DEFAULT_RPM),
    ],
)
def test_limits_per_host(host, rpm):
    assert rpm_for(host) == rpm


def test_queues_instead_of_failing_once_the_minute_is_full():
    clock = Clock()
    limiter = RateLimiter((("api.example", 3),), clock=clock, sleep=clock.sleep)
    waits = []
    for _ in range(3):
        waits.append(limiter.acquire("api.example"))
        clock.now += 1
    # 第 4 次要等到第 1 次滑出 60 秒的窗口
    waits.append(limiter.acquire("api.example"))
    assert waits[:3] == [0, 0, 0]
    assert waits[3] == pytest.approx(57)
    # 别的主机不受影响
    assert limiter.acquire("other.example") == 0


def test_sliding_window_frees_slots_as_requests_age():
    clock = Clock()
    limiter = RateLimiter((("api.example", 2),), clock=clock, sleep=clock.sleep)
    limiter.acquire("api.example")
    clock.now += 30
    limiter.acquire("api.example")
    clock.now += 31
    # 第 1 次已经超过 60 秒，不用等
    assert limiter.acquire("api.example") == 0
    assert limiter.acquire("api.example") == pytest.approx(29)


def test_threads_share_the_count():
    limiter = RateLimiter((("api.example", 5),), sleep=lambda s: None, clock=lambda: 0.0)
    waited = []

    def take():
        waited.append(limiter.acquire("api.example"))

    threads = [threading.Thread(target=take) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert waited == [0, 0, 0, 0, 0]


def test_every_real_request_takes_a_slot(monkeypatch):
    taken = []
    monkeypatch.setattr(LIMITER, "acquire", lambda host: taken.append(host) or 0.0)

    class Opened:
        status = 200
        headers = {}

        def read(self, n):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(hg._opener, "open", lambda request, timeout: Opened())
    hg.urllib_send("GET", "https://wiki.biligame.com/ys/api.php?x=1", {}, None, 5)
    assert taken == ["wiki.biligame.com"]


def test_rules_cover_every_whitelisted_upstream():
    import json

    from arkrecord_backend.hg import shared_dir

    hosts = set()
    for name in ("hg.json", "mhy.json"):
        data = json.loads((shared_dir() / "upstreams" / name).read_text(encoding="utf-8"))
        hosts |= {v["host"] for v in data.values() if isinstance(v, dict) and "host" in v}
    # 鹰角、米哈游的接口都有专门的上限，不落到默认值
    assert all(rpm_for(h) != DEFAULT_RPM for h in hosts), hosts
    assert len(RPM_RULES) >= 7
