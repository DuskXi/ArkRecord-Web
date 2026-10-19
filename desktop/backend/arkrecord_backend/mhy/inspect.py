"""只读检查（给开发者在本机验证用）：找游戏目录、数缓存里的抽卡链接。

    uv run --project desktop/backend python -m arkrecord_backend.mhy.inspect genshin
    uv run --project desktop/backend python -m arkrecord_backend.mhy.inspect starrail [游戏目录]

只输出“找到几条、参数名有哪些、属于哪个服务器”，不输出参数值（authkey 等），不发任何请求。
路径里的用户名换成 ***。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .cache import cache_files, gacha_urls, read_cache, version_dirs
from .games import GAMES
from .link import parse_link
from .locate import find_data_dirs, log_paths, resolve_data_dir


def _mask(path: Path) -> str:
    text = str(path)
    user = os.environ.get("USERNAME") or os.environ.get("USER")
    return text.replace(user, "***") if user else text


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in GAMES:
        print(__doc__)
        return 2
    game = GAMES[argv[0]]
    home = Path.home()
    if len(argv) > 1:
        chosen = resolve_data_dir(Path(argv[1]), game)
        dirs = [chosen] if chosen else []
        print(f"手动选择的目录：{'找到游戏数据目录' if chosen else '没有找到 webCaches'}")
    else:
        logs, dirs = find_data_dirs(game, home)
        for path in log_paths(game, home):
            print(f"日志 {_mask(path)}：{'存在' if path in logs else '不存在'}")
    if not dirs:
        print("没有找到游戏数据目录")
        return 1
    for data_dir in dirs:
        print(f"游戏数据目录：{_mask(data_dir)}")
        print(f"  版本目录（从新到旧）：{', '.join(d.name for d in version_dirs(data_dir)) or '无'}")
        for path in cache_files(data_dir):
            version = path.parent.parent.parent.name
            try:
                urls = gacha_urls(read_cache(path))
            except OSError as error:
                print(f"  {version}：读取失败（{type(error).__name__}）")
                continue
            links = [link for link in map(parse_link, urls) if link and link.game is game]
            print(f"  {version}：抽卡相关地址 {len(urls)} 条，能用的抽卡链接 {len(links)} 条")
            if links:
                newest = links[0]
                names = ", ".join(key for key, _ in newest.params)
                print(f"    最新一条：服务器 {newest.upstream}，接口路径 {newest.api_base}，参数 {names}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
