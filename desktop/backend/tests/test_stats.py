"""桌面版统计：假的服务器、手动执行的定时任务，不发真实请求。UID 都是假的。"""

import hashlib
import json
import random
from datetime import UTC, datetime

import pytest

from arkrecord_backend.app import build_methods
from arkrecord_backend.hg import UpstreamResponse
from arkrecord_backend.rpc import INVALID_PARAMS, RpcError
from arkrecord_backend.stats import UID_DELAY_RANGE, Stats, cn_day, uid_hash

BASE = "https://ark-next.kaltsit.dev"
NOON = datetime(2026, 10, 16, 4, 0, tzinfo=UTC)  # 北京时间 12:00


class FakeServer:
    def __init__(self, status=204):
        self.calls = []
        self.status = status

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": json.loads(body)})
        return UpstreamResponse(self.status, [], b"")


class Scheduler:
    def __init__(self):
        self.tasks = []

    def __call__(self, delay, task):
        self.tasks.append((delay, task))

    def run(self):
        tasks, self.tasks = self.tasks, []
        for _, task in tasks:
            task()


def make(tmp_path, server=None, base=BASE, clock=lambda: NOON):
    scheduler = Scheduler()
    stats = Stats(tmp_path, base, server or FakeServer(), scheduler, clock, random.Random(1))
    return stats, scheduler


ACCOUNTS = [{"game": "arknights", "uid": "100000001"}, {"game": "genshin", "uid": "200000002"}]


def test_device_and_uids_are_separate_requests_without_shared_fields(tmp_path):
    server = FakeServer()
    stats, scheduler = make(tmp_path, server)
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 3}
    delays = [delay for delay, _ in scheduler.tasks]
    assert delays[0] == 0 and all(UID_DELAY_RANGE[0] <= d <= UID_DELAY_RANGE[1] for d in delays[1:])
    scheduler.run()
    device, *uids = server.calls
    assert device["url"] == f"{BASE}/api/stats/desktop/device"
    assert set(device["body"]) == {"hash", "loggedIn"} and device["body"]["loggedIn"] is True
    assert device["headers"]["x-arkrecord-client"] == "desktop"
    assert {u["url"] for u in uids} == {f"{BASE}/api/stats/desktop/uid"}
    assert sorted(u["body"]["game"] for u in uids) == ["arknights", "genshin"]
    for u in uids:
        assert set(u["body"]) == {"game", "hash"}
        assert u["body"]["hash"] != device["body"]["hash"]
    # 不上传原始 UID 和设备 ID
    raw = json.dumps(server.calls)
    assert "100000001" not in raw and "200000002" not in raw
    device_id = json.loads((tmp_path / "stats.json").read_text())["deviceId"]
    assert device_id not in raw


def test_uid_hash_is_salted_with_game_prefix():
    expected = hashlib.sha256(b"arkrecord-uid-v1:arknights:100000001").hexdigest()
    assert uid_hash("arknights", "100000001") == expected
    assert uid_hash("endfield", "100000001") != expected


def test_no_accounts_means_logged_out_device(tmp_path):
    server = FakeServer()
    stats, scheduler = make(tmp_path, server)
    stats.report({"accounts": [{"game": "arknights", "uid": "demo"}]})
    scheduler.run()
    assert len(server.calls) == 1 and server.calls[0]["body"]["loggedIn"] is False


def test_once_per_day_and_again_tomorrow(tmp_path):
    server = FakeServer()
    now = {"t": NOON}
    stats, scheduler = make(tmp_path, server, clock=lambda: now["t"])
    stats.report({"accounts": ACCOUNTS})
    scheduler.run()
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 0}
    now["t"] = datetime(2026, 10, 17, 4, 0, tzinfo=UTC)
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 3}


def test_failed_reports_are_retried_next_time(tmp_path):
    stats, scheduler = make(tmp_path, FakeServer(status=503))
    stats.report({"accounts": ACCOUNTS})
    scheduler.run()
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 3}


def test_disabled_sends_nothing(tmp_path):
    server = FakeServer()
    stats, scheduler = make(tmp_path, server)
    assert stats.status(None) == {"enabled": True, "available": True}
    stats.report({"accounts": ACCOUNTS})
    assert stats.set_enabled({"enabled": False}) == {"enabled": False}
    # 关闭前已经排好的任务也不发出
    scheduler.run()
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 0}
    assert [c["url"] for c in server.calls] == [f"{BASE}/api/stats/desktop/device"]
    assert stats.status(None)["enabled"] is False


def test_device_id_is_random_and_kept(tmp_path):
    stats, _ = make(tmp_path)
    stats.report({"accounts": []})
    first = json.loads((tmp_path / "stats.json").read_text())["deviceId"]
    stats.report({"accounts": []})
    assert json.loads((tmp_path / "stats.json").read_text())["deviceId"] == first
    other, _ = make(tmp_path / "other")
    other.report({"accounts": []})
    assert json.loads((tmp_path / "other" / "stats.json").read_text())["deviceId"] != first


@pytest.mark.parametrize("base", ["", "https://evil.example", "http://ark.kaltsit.dev"])
def test_only_reports_to_this_site(tmp_path, base):
    server = FakeServer()
    stats, scheduler = make(tmp_path, server, base=base)
    assert stats.status(None)["available"] is False
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 0}
    scheduler.run()
    assert server.calls == []


def test_without_data_dir_nothing_is_written_or_sent(monkeypatch):
    monkeypatch.delenv("ARKRECORD_DATA_DIR", raising=False)
    server = FakeServer()
    stats = Stats(None, BASE, server, Scheduler(), lambda: NOON)
    assert stats.report({"accounts": ACCOUNTS}) == {"scheduled": 0}
    assert server.calls == []


@pytest.mark.parametrize(
    "params",
    [None, {}, {"accounts": "x"}, {"accounts": [{"game": "arknights"}]}, {"accounts": [], "x": 1}],
)
def test_report_validates_params(tmp_path, params):
    stats, _ = make(tmp_path)
    with pytest.raises(RpcError) as info:
        stats.report(params)
    assert info.value.code == INVALID_PARAMS


def test_invalid_accounts_are_skipped(tmp_path):
    stats, _ = make(tmp_path)
    result = stats.report({"accounts": [{"game": "zzz", "uid": "1"}, {"game": "arknights", "uid": "bad uid"}]})
    assert result == {"scheduled": 1}  # 只有设备


def test_set_enabled_validates(tmp_path):
    stats, _ = make(tmp_path)
    for params in (None, {"enabled": "no"}, {"enabled": True, "x": 1}):
        with pytest.raises(RpcError):
            stats.set_enabled(params)


def test_cn_day_uses_beijing_time():
    assert cn_day(datetime(2026, 10, 16, 16, 30, tzinfo=UTC)) == "2026-10-17"


def test_methods_are_registered():
    assert {"stats.status", "stats.setEnabled", "stats.report"} <= set(build_methods())
