"""原神、星铁的差异：日志位置、游戏数据目录名、卡池。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Game:
    id: str
    # game_biz 的前缀：hk4e、hkrpg
    biz: str
    # 日志文件，相对于 %USERPROFILE%\AppData\LocalLow（国服、国际服各一个，再加上一次运行留下的日志）
    log_files: tuple[str, ...]
    # 游戏数据目录名（YuanShen_Data 等），webCaches 在它下面
    data_dirs: tuple[str, ...]
    # 拉取时要查的卡池
    gacha_types: tuple[str, ...]
    # 校验链接时查的卡池（常驻，所有人都有）
    standard_gacha_type: str
    # 走 getLdGachaLog 的卡池（星铁联动池）
    ld_gacha_types: tuple[str, ...] = ()


GENSHIN = Game(
    id="genshin",
    biz="hk4e",
    log_files=("miHoYo/原神/output_log.txt", "miHoYo/Genshin Impact/output_log.txt"),
    data_dirs=("YuanShen_Data", "GenshinImpact_Data"),
    # 100 新手、200 常驻、301 角色活动（会同时返回 400）、302 武器活动、500 集录
    gacha_types=("100", "200", "301", "302", "500"),
    standard_gacha_type="200",
)

STARRAIL = Game(
    id="starrail",
    biz="hkrpg",
    # 国服目录名里是全角冒号
    log_files=(
        "miHoYo/崩坏：星穹铁道/Player.log",
        "Cognosphere/Star Rail/Player.log",
        "miHoYo/崩坏：星穹铁道/Player-prev.log",
        "Cognosphere/Star Rail/Player-prev.log",
    ),
    data_dirs=("StarRail_Data",),
    # 1 常驻、2 新手、11 角色活动、12 光锥活动、21 角色联动、22 光锥联动
    gacha_types=("1", "2", "11", "12", "21", "22"),
    standard_gacha_type="1",
    ld_gacha_types=("21", "22"),
)

GAMES: dict[str, Game] = {game.id: game for game in (GENSHIN, STARRAIL)}


def game_for_biz(game_biz: str) -> Game | None:
    prefix = game_biz.split("_", 1)[0]
    return next((game for game in GAMES.values() if game.biz == prefix), None)
