"""米哈游真实请求实验（给开发者在本机验证用）。

    uv run --project desktop/backend python -m arkrecord_backend.mhy.probe genshin         # 只看会发什么
    uv run --project desktop/backend python -m arkrecord_backend.mhy.probe genshin --yes   # 真的发请求
    （可选：--data-dir <游戏目录>，--max-pages <每个卡池最多几页>）

不加 --yes 时只读缓存、列出会发哪些请求，不联网。
加 --yes 后走和应用完全相同的代码（MhyService 的 readCache、fetchPage）：
校验缓存里的抽卡链接（每条 1 次请求，过期的换下一条，最多 5 条），再把每个卡池从新到旧拉到最后一页
（每页 20 条，两次请求至少间隔 0.5 秒，本机直连官方接口，不经过 Cloudflare 或任何 Worker）。

只输出：每一步成功与否、错误种类、每个卡池的页数和条数、记录里有哪些字段、
格式检查（id、时间、顺序、重复、uid 是否和链接一致）、区服和时区。
不输出 authkey、UID、记录内容（名称、物品、id、时间）；路径里的用户名换成 ***。
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, TextIO

from ..rpc import RpcError
from .gacha import MAX_PAGE_SIZE, MIN_INTERVAL_S, GachaApi
from .games import GAMES, Game
from .inspect import mask_path
from .service import MAX_CANDIDATES, MhyService

TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
ID_RE = re.compile(r"^\d{1,24}$")
DEFAULT_MAX_PAGES = 500


class PoolCheck:
    """一个卡池拉下来的记录的格式检查。只记数量和取值种类，不留记录内容。"""

    def __init__(self) -> None:
        self.pages = 0
        self.records = 0
        self.fields: set[str] = set()
        self.gacha_types: Counter[str] = Counter()
        # gacha_type → op_gacha_type 的对应（含义还没确认，先看取值）
        self.op_types: Counter[tuple[str, str]] = Counter()
        self.id_lengths: set[int] = set()
        self.bad_ids = 0
        self.bad_times = 0
        self.out_of_order = 0
        self.duplicates = 0
        self.other_uid = 0
        self.empty_item_id = 0
        self.rank_types: set[str] = set()
        self.langs: set[str] = set()
        self.time_zones: set[str] = set()
        self._seen: set[str] = set()
        self._last: int | None = None

    def add(self, record: Any, uid: str | None) -> str | None:
        """记一条记录，返回它的 id（翻页用）；不是合格的记录返回 None。"""
        self.records += 1
        if not isinstance(record, dict):
            self.bad_ids += 1
            return None
        self.fields.update(str(key) for key in record)
        self.gacha_types[str(record.get("gacha_type"))] += 1
        if "op_gacha_type" in record:
            self.op_types[(str(record.get("gacha_type")), str(record.get("op_gacha_type")))] += 1
        if uid is not None and record.get("uid") != uid:
            self.other_uid += 1
        if not record.get("item_id"):
            self.empty_item_id += 1
        for target, key in ((self.rank_types, "rank_type"), (self.langs, "lang")):
            if isinstance(record.get(key), str):
                target.add(record[key])
        if not (isinstance(record.get("time"), str) and TIME_RE.match(record["time"])):
            self.bad_times += 1
        record_id = record.get("id")
        if not (isinstance(record_id, str) and ID_RE.match(record_id)):
            self.bad_ids += 1
            return None
        self.id_lengths.add(len(record_id))
        if record_id in self._seen:
            self.duplicates += 1
        self._seen.add(record_id)
        # 接口从新到旧返回：id 应该一路变小
        if self._last is not None and int(record_id) >= self._last:
            self.out_of_order += 1
        self._last = int(record_id)
        return record_id

    def problems(self) -> list[str]:
        found = []
        if self.bad_ids:
            found.append(f"id 不是数字字符串 {self.bad_ids} 条")
        if self.bad_times:
            found.append(f"时间格式不是 YYYY-MM-DD HH:MM:SS {self.bad_times} 条")
        if self.out_of_order:
            found.append(f"顺序不是从新到旧 {self.out_of_order} 处")
        if self.duplicates:
            found.append(f"重复的 id {self.duplicates} 条")
        if self.other_uid:
            found.append(f"uid 和链接的不一致 {self.other_uid} 条")
        return found

    def summary(self) -> list[str]:
        types = "、".join(f"{t}×{n}" for t, n in sorted(self.gacha_types.items()))
        lines = [f"{self.pages} 页，{self.records} 条" + (f"（gacha_type {types}）" if types else "")]
        if self.records:
            lines.append(f"字段：{', '.join(sorted(self.fields))}")
            lengths = "、".join(str(n) for n in sorted(self.id_lengths)) or "无"
            lines.append(
                f"id 位数 {lengths}；rank_type 取值 {'/'.join(sorted(self.rank_types)) or '无'}；"
                f"lang {'/'.join(sorted(self.langs)) or '无'}；item_id 为空 {self.empty_item_id} 条"
            )
        if self.op_types:
            pairs = "、".join(f"{g}→{o}×{n}" for (g, o), n in sorted(self.op_types.items()))
            lines.append(f"gacha_type→op_gacha_type：{pairs}")
        if self.time_zones:
            lines.append(f"region_time_zone：{'/'.join(sorted(self.time_zones))}")
        problems = self.problems()
        lines.append("✗ " + "；".join(problems) if problems else "✓ 格式检查都通过")
        return lines


def _error(error: RpcError) -> str:
    # message 是给用户看的中文说明，不含凭据（见 rpc.AppError）
    return f"{error.kind or error.code}：{error.message}"


def dry_run(game: Game, service: MhyService, out: TextIO, data_dir: str | None, max_pages: int) -> int:
    try:
        links = service.find_links(game, data_dir)
    except RpcError as error:
        print(f"✗ 找链接失败：{_error(error)}", file=out)
        return 1
    if not links:
        print("✗ 缓存里没有抽卡链接：请先在游戏里打开一次抽卡记录", file=out)
        return 1
    api = service.api
    print(f"缓存里找到 {len(links)} 条抽卡链接（新的在前）。没有发任何请求。", file=out)
    print("加 --yes 后会发送：", file=out)
    for upstream in dict.fromkeys(link.upstream for link in links):
        host = api.upstream_host(upstream)
        paths = sorted({api.path_for(link, t) for link in links if link.upstream == upstream for t in game.gacha_types})
        print(f"- 发给 {host}：{', '.join(paths)}（只读抽卡记录）", file=out)
    print(f"- 先校验链接：每条 1 次请求，过期的换下一条，最多 {MAX_CANDIDATES} 条", file=out)
    pools = ", ".join(game.gacha_types)
    print(f"- 再拉卡池 {pools}：每页 {MAX_PAGE_SIZE} 条，拉到最后一页（每个卡池最多 {max_pages} 页）", file=out)
    print(f"- 两次请求至少间隔 {MIN_INTERVAL_S} 秒；本机直连，不经过 Cloudflare 或任何 Worker", file=out)
    return 0


def run(game: Game, service: MhyService, out: TextIO, data_dir: str | None, max_pages: int) -> int:
    params: dict[str, Any] = {"game": game.id}
    if data_dir:
        params["dataDir"] = data_dir
    try:
        link = service.read_cache(params)
    except RpcError as error:
        print(f"✗ 读取或校验链接失败：{_error(error)}", file=out)
        return 1
    uid = link.get("uid")
    print(
        f"✓ 链接有效：{link['gameBiz']}，区服 {link['region']}，"
        f"{'从常驻池的记录取到了 UID（不显示）' if uid else '常驻池没有记录，取不到 UID'}",
        file=out,
    )
    handle = link["handle"]
    ok = True
    pages = 0
    try:
        for gacha_type in game.gacha_types:
            check = PoolCheck()
            end_id = "0"
            error: RpcError | None = None
            while check.pages < max_pages:
                try:
                    page = service.fetch_page({"handle": handle, "gachaType": gacha_type, "endId": end_id})
                except RpcError as caught:
                    error = caught
                    break
                check.pages += 1
                pages += 1
                if page.get("regionTimeZone") is not None:
                    check.time_zones.add(str(page["regionTimeZone"]))
                last = None
                for record in page["list"]:
                    last = check.add(record, uid)
                if len(page["list"]) < MAX_PAGE_SIZE or last is None:
                    break
                end_id = last
            else:
                print(f"卡池 {gacha_type}：到了页数上限 {max_pages}，没有拉完", file=out)
            print(f"卡池 {gacha_type}：" + "\n  ".join(check.summary()), file=out)
            if error is not None:
                print(f"  ✗ 第 {check.pages + 1} 页失败：{_error(error)}", file=out)
                ok = False
                if error.kind in ("link_expired", "link_invalid", "rate_limited"):
                    break
            ok = ok and not check.problems()
    finally:
        service.forget({"handle": handle})
    print(f"{'✓ 完成' if ok else '✗ 有问题，见上面'}：拉记录一共 {pages} 次请求（另有校验链接的请求）", file=out)
    return 0 if ok else 1


def main(argv: list[str], out: TextIO = sys.stdout, service: MhyService | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m arkrecord_backend.mhy.probe", description=__doc__.split("\n")[0])
    parser.add_argument("game", choices=sorted(GAMES))
    parser.add_argument("--data-dir", help="游戏目录（找不到时手动指定）")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="每个卡池最多拉几页")
    parser.add_argument("--yes", action="store_true", help="真的发请求（不加时只列出会发什么）")
    args = parser.parse_args(argv)
    if args.max_pages < 1:
        parser.error("--max-pages 至少为 1")
    game = GAMES[args.game]
    service = service or MhyService(api=GachaApi())
    if args.data_dir:
        print(f"手动指定的目录：{mask_path(Path(args.data_dir))}", file=out)
    if not args.yes:
        return dry_run(game, service, out, args.data_dir, args.max_pages)
    return run(game, service, out, args.data_dir, args.max_pages)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
