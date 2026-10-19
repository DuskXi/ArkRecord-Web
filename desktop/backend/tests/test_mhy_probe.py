"""本机实验命令：假的米哈游接口（按 end_id 翻页），不发真实请求。authkey、UID、记录都是假的。"""

import io
import json
from urllib.parse import parse_qs, urlsplit

from mhy_fakes import GENSHIN_PAGE, cache_blob, make_install

from arkrecord_backend.hg import UpstreamResponse
from arkrecord_backend.mhy.gacha import GachaApi
from arkrecord_backend.mhy.probe import main
from arkrecord_backend.mhy.service import MhyService

UID = "100000001"
KEY = "FAKE_PROBE_KEY"


def record(gacha_type, n, **extra):
    return {
        "uid": UID,
        "gacha_type": gacha_type,
        "item_id": "",
        "count": "1",
        "time": "2026-10-01 12:00:00",
        "name": f"假物品{n}",
        "lang": "zh-cn",
        "item_type": "角色",
        "rank_type": "4",
        "id": str(1700000000000000000 + n),
        **extra,
    }


class PagedMhy:
    """每个卡池一列记录（从新到旧），按 end_id 和 size 翻页；authkey 带 expired 时返回 -101。"""

    def __init__(self, pools):
        self.pools = pools
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        self.calls.append(query)
        if "expired" in query["authkey"]:
            payload = {"retcode": -101, "message": "fake", "data": None}
        else:
            items = self.pools.get(query["gacha_type"], [])
            if query["end_id"] != "0":
                items = [r for r in items if int(r["id"]) < int(query["end_id"])]
            data = {"list": items[: int(query["size"])], "region": "cn_gf01", "region_time_zone": 8}
            payload = {"retcode": 0, "message": "OK", "data": data}
        return UpstreamResponse(200, [("Content-Type", "application/json")], json.dumps(payload).encode())


def setup(tmp_path, pools, key=KEY):
    data = make_install(tmp_path / "Game", versions={"5.0.0.0": cache_blob(GENSHIN_PAGE.format(key=key))})
    fake = PagedMhy(pools)
    service = MhyService(api=GachaApi(send=fake, sleep=lambda _: None), home=tmp_path)
    return data, fake, service


def probe(service, *argv):
    out = io.StringIO()
    code = main(list(argv), out=out, service=service)
    return code, out.getvalue()


def test_without_yes_sends_nothing(tmp_path):
    data, fake, service = setup(tmp_path, {})
    code, text = probe(service, "genshin", "--data-dir", str(data))
    assert code == 0 and fake.calls == []
    assert "public-operation-hk4e.mihoyo.com" in text and "/gacha_info/api/getGachaLog" in text
    assert "没有发任何请求" in text and KEY not in text


def test_pages_through_every_pool_and_prints_only_counts(tmp_path):
    # 常驻 45 条（3 页），角色活动 301 混着 400 共 25 条，其余卡池没有记录
    standard = [record("200", 1000 - i) for i in range(45)]
    event = [record("301" if i % 2 else "400", 500 - i, rank_type="5", op_gacha_type="301") for i in range(25)]
    data, fake, service = setup(tmp_path, {"200": standard, "301": event})
    code, text = probe(service, "genshin", "--yes", "--data-dir", str(data))
    assert code == 0, text
    assert "卡池 200：3 页，45 条" in text
    assert "卡池 301：2 页，25 条（gacha_type 301×12、400×13）" in text
    assert "卡池 100：1 页，0 条" in text
    assert "gacha_type→op_gacha_type：301→301×12、400→301×13" in text
    assert "region_time_zone：8" in text and "✓ 完成" in text
    # 翻页用上一页最后一条的 id
    pages = [c for c in fake.calls if c["gacha_type"] == "200" and c["size"] == "20"]
    assert [c["end_id"] for c in pages] == ["0", standard[19]["id"], standard[39]["id"]]
    # 不输出 authkey、UID、记录内容
    for secret in (KEY, UID, "假物品", standard[0]["id"], "2026-10-01"):
        assert secret not in text


def test_format_problems_are_reported(tmp_path):
    bad = [record("200", 10), record("200", 20), record("200", 5, time="10/01"), record("200", 5, uid="999")]
    data, _, service = setup(tmp_path, {"200": bad})
    code, text = probe(service, "genshin", "--yes", "--data-dir", str(data))
    assert code == 1
    # 10 → 20 倒序，5 → 5 重复（也算倒序）
    assert "顺序不是从新到旧 2 处" in text and "重复的 id 1 条" in text
    assert "时间格式不是 YYYY-MM-DD HH:MM:SS 1 条" in text and "uid 和链接的不一致 1 条" in text
    assert "999" not in text


def test_expired_link_stops_before_fetching(tmp_path):
    data, fake, service = setup(tmp_path, {}, key="FAKE_expired")
    code, text = probe(service, "genshin", "--yes", "--data-dir", str(data))
    assert code == 1 and "link_expired" in text
    assert len(fake.calls) == 1 and "FAKE_expired" not in text


def test_max_pages(tmp_path):
    standard = [record("200", 1000 - i) for i in range(45)]
    data, fake, service = setup(tmp_path, {"200": standard})
    code, text = probe(service, "genshin", "--yes", "--data-dir", str(data), "--max-pages", "1")
    assert "卡池 200：到了页数上限 1，没有拉完" in text
    assert len([c for c in fake.calls if c["gacha_type"] == "200" and c["size"] == "20"]) == 1
