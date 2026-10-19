"""合成的游戏目录、缓存和假的米哈游接口。所有 authkey、UID 都是假的。"""

import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from arkrecord_backend.hg import UpstreamResponse

GENSHIN_PAGE = (
    "https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-fake01/index.html?win_mode=fullscreen&no_joypad_close=1"
    "&authkey_ver=1&sign_type=2&auth_appid=webview_gacha&gacha_id=fakegacha&timestamp=1700000000&lang=zh-cn"
    "&device_type=pc&game_version=CNRELWin9.9.0_R1_S1_D1&region=cn_gf01&authkey={key}&game_biz=hk4e_cn#/log"
)
STARRAIL_API = (
    "https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog?authkey_ver=1&sign_type=2"
    "&auth_appid=webview_gacha&default_gacha_type=11&lang=zh-cn&authkey={key}&game_biz=hkrpg_cn&os_system=x&page=1&size=5"
)


def cache_blob(*urls: str) -> bytes:
    """仿 Chromium 磁盘缓存：二进制噪声里夹着以 1/0/ 开头的缓存键。"""
    parts = [b"\x00\x01\xfe\xffnoise"]
    for url in urls:
        parts.append(b"1/0/" + url.encode() + b"\x00\x00\x93\x02binary\xff")
        parts.append(b"https://webstatic.mihoyo.com/static/app.js\x00")
    return b"".join(parts)


def make_install(root: Path, data_dir: str = "YuanShen_Data", versions: dict[str, bytes] | None = None) -> Path:
    """root/<data_dir>/webCaches/<版本>/Cache/Cache_Data/data_2，另加几个不是版本号的目录。"""
    data = root / data_dir
    web_caches = data / "webCaches"
    for name in ("Cache", "Network", "IndexedDB"):
        (web_caches / name).mkdir(parents=True, exist_ok=True)
    for version, blob in (versions or {}).items():
        cache = web_caches / version / "Cache" / "Cache_Data"
        cache.mkdir(parents=True, exist_ok=True)
        if blob is not None:
            (cache / "data_2").write_bytes(blob)
    return data


class FakeMhy:
    """按 authkey 返回不同结果：expired → -101，invalid → -100，busy → -110，其余正常。"""

    def __init__(self, records=None):
        self.calls = []
        self.records = records or [
            {"uid": "100000001", "id": "1700000000000000001", "gacha_type": "200", "name": "假物品"}
        ]

    def __call__(self, method, url, headers, body, timeout):
        parts = urlsplit(url)
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        self.calls.append(
            {"url": url, "host": parts.netloc, "path": parts.path, "query": query, "headers": dict(headers)}
        )
        key = query.get("authkey", "")
        retcode = -101 if "expired" in key else -100 if "invalid" in key else -110 if "busy" in key else 0
        if retcode:
            payload = {"retcode": retcode, "message": "fake", "data": None}
        else:
            size = int(query["size"])
            payload = {
                "retcode": 0,
                "message": "OK",
                "data": {"page": "1", "size": str(size), "list": self.records[:size], "region": "cn_gf01"},
            }
        return UpstreamResponse(200, [("Content-Type", "application/json")], json.dumps(payload).encode())
