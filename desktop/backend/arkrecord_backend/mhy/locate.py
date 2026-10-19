"""找游戏数据目录：读游戏日志（只用来找目录，日志里没有抽卡链接），或者用用户手动选的目录。"""

from __future__ import annotations

import re
from pathlib import Path

from ..readonly import read_bytes
from .games import Game

# 日志可能很大；只读最后这么多字节，游戏目录在每次启动时都会写进去
MAX_LOG_BYTES = 32 * 1024 * 1024


def log_paths(game: Game, home: Path) -> list[Path]:
    """Windows 上的日志位置（Linux 上的 Wine 前缀、macOS 不在这里找，用手动选择的目录）。"""
    base = home / "AppData" / "LocalLow"
    return [base.joinpath(*relative.split("/")) for relative in game.log_files]


def _read_tail(path: Path) -> str:
    # 游戏开着时也在写日志、启动时还会轮换（改名），所以完全只读、读完马上关闭（readonly.py）
    return read_bytes(path, MAX_LOG_BYTES, tail=True).decode("utf-8", errors="replace")


def data_dirs_in_log(text: str, game: Game) -> list[Path]:
    """日志里出现的游戏数据目录，最后出现的排在前面。"""
    names = "|".join(re.escape(name) for name in game.data_dirs)
    pattern = re.compile(rf"([A-Za-z]:[/\\][^\r\n:*?\"<>|]*?(?:{names}))(?=[/\\\s\"']|$)", re.MULTILINE)
    found: list[str] = []
    for match in pattern.finditer(text):
        path = match.group(1).replace("\\", "/")
        if path in found:
            found.remove(path)
        found.append(path)
    return [Path(path) for path in reversed(found)]


def find_data_dirs(game: Game, home: Path) -> tuple[list[Path], list[Path]]:
    """返回 (找到的日志, 存在 webCaches 的游戏数据目录)。"""
    logs = [path for path in log_paths(game, home) if path.is_file()]
    dirs: list[Path] = []
    for log in logs:
        try:
            text = _read_tail(log)
        except OSError:
            continue
        for path in data_dirs_in_log(text, game):
            if path not in dirs and (path / "webCaches").is_dir():
                dirs.append(path)
    return logs, dirs


def resolve_data_dir(chosen: Path, game: Game) -> Path | None:
    """用户手动选的目录：可以是游戏安装目录、游戏数据目录或 webCaches 本身。"""
    candidates = [chosen, *(chosen / name for name in game.data_dirs)]
    if chosen.name == "webCaches":
        candidates.insert(0, chosen.parent)
    # 启动器的安装目录下面还有一层游戏目录（如 Genshin Impact Game、Game）
    if chosen.is_dir():
        for child in sorted(chosen.iterdir()):
            if child.is_dir():
                candidates.extend(child / name for name in game.data_dirs)
    for path in candidates:
        if path.name in game.data_dirs and (path / "webCaches").is_dir():
            return path
    return None
