"""解析抽卡链接：只保留拉记录需要的参数，其余（时间戳、设备、版本、玩家坐标等）一律丢掉。"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

from .games import Game, game_for_biz

# 拉记录需要的参数；gacha_type、page、size、end_id 由请求时填
KEEP_PARAMS = ("authkey", "authkey_ver", "sign_type", "auth_appid", "game_biz", "region", "lang")
MAX_URL_LENGTH = 8192


@dataclass(frozen=True)
class GachaLink:
    game: Game
    game_biz: str
    # shared/upstreams/mhy.json 里的键：hk4e_cn、hkrpg_global 等
    upstream: str
    # 星铁的接口路径有 gacha_record 和 hkrpg_gacha_record 两种，按链接里的用
    api_base: str
    params: tuple[tuple[str, str], ...]

    def param(self, name: str) -> str | None:
        return next((value for key, value in self.params if key == name), None)


def _pairs(query: str) -> list[tuple[str, str]]:
    # 不用 parse_qsl：它会把 + 当成空格，authkey 里没编码的 + 会被改坏
    pairs = []
    for part in query.split("&"):
        if part:
            key, _, value = part.partition("=")
            pairs.append((unquote(key), unquote(value)))
    return pairs


def parse_link(url: str) -> GachaLink | None:
    url = url.strip()
    if len(url) > MAX_URL_LENGTH or not url.startswith("https://"):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    pairs = _pairs(parts.query)
    # 有的页面把参数放在 # 后面（前端路由）
    if not any(key == "authkey" for key, _ in pairs) and "?" in parts.fragment:
        pairs = _pairs(parts.fragment.split("?", 1)[1])
    params = {key: value for key, value in pairs if key in KEEP_PARAMS and value}
    authkey, game_biz = params.get("authkey"), params.get("game_biz", "")
    game = game_for_biz(game_biz)
    if not authkey or game is None or "gacha" not in url.lower():
        return None
    if game_biz.endswith("_global"):
        upstream = f"{game.biz}_global"
    elif game_biz.endswith("_cn"):
        upstream = f"{game.biz}_cn"
    else:
        return None
    api_base = "hkrpg_gacha_record" if "/hkrpg_gacha_record/" in parts.path else "gacha_record"
    params.setdefault("lang", "zh-cn")
    return GachaLink(
        game=game,
        game_biz=game_biz,
        upstream=upstream,
        api_base=api_base,
        params=tuple((key, params[key]) for key in KEEP_PARAMS if key in params),
    )
