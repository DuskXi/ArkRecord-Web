"""桌面版的使用人数统计（维护者 2026-10-19 决定；服务器端见 worker/desktop-stats.ts，说明见 SECURITY.md）。

- 默认开启，页面的“关于”里可以关闭（stats.setEnabled）；关闭后不发出任何统计请求。
- 设备：安装时随机生成的设备 ID（不读任何硬件信息），上报它的 SHA-256 和“有没有登录账号”；每天最多一次。
- 账号：每个账号单独一次请求，上报 SHA-256("arkrecord-uid-v1:<游戏>:<UID>")；每个账号每天最多一次。
- 用户：同步识别码（开通过云同步才有，见 docs/rewrite/sync-user-id.md），
  上报 SHA-256("arkrecord-user-v1:<识别码>")；每天最多一次。
- 设备、账号、用户互相不关联：分开请求，账号和用户的请求在设备之后随机延迟、顺序打乱，请求里没有共同字段。
- 服务器再用自己的密钥做 HMAC 才保存（UID 只有 9 位左右，单纯哈希可以穷举反查）。
- 只发给 ARKRECORD_STATS_URL 指定的本站地址（正式站或测试站）；没设置时不上报。

状态存在应用数据目录（ARKRECORD_DATA_DIR）的 stats.json：开关、设备 ID、今天已经报过的设备 / 账号 / 用户。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import __version__
from .hg import Sender, urllib_send
from .rpc import INVALID_PARAMS, Params, RpcError

log = logging.getLogger(__name__)

ALLOWED_BASES = ("https://ark.kaltsit.dev", "https://ark-next.kaltsit.dev")
GAMES = ("arknights", "endfield", "genshin", "starrail")
UID_PREFIX = "arkrecord-uid-v1"
USER_PREFIX = "arkrecord-user-v1"
UID_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
SYNC_USER_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_ACCOUNTS = 64
# 账号的请求在设备之后多久发（秒），每个账号单独随机
UID_DELAY_RANGE = (30.0, 300.0)
TIMEOUT_S = 15
# 北京时间（没有夏令时），和网页版统计的“今天”一致
CN = timezone(timedelta(hours=8))
STATE_FILE = "stats.json"


def cn_day(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(CN).strftime("%Y-%m-%d")


def uid_hash(game: str, uid: str) -> str:
    return hashlib.sha256(f"{UID_PREFIX}:{game}:{uid}".encode()).hexdigest()


def user_hash(sync_user: str) -> str:
    return hashlib.sha256(f"{USER_PREFIX}:{sync_user}".encode()).hexdigest()


def device_hash(device_id: str) -> str:
    return hashlib.sha256(f"arkrecord-device-v1:{device_id}".encode()).hexdigest()


Scheduler = Callable[[float, Callable[[], None]], None]


def _thread_scheduler(delay: float, task: Callable[[], None]) -> None:
    timer = threading.Timer(delay, task)
    timer.daemon = True
    timer.start()


class Stats:
    def __init__(
        self,
        data_dir: Path | None = None,
        base_url: str | None = None,
        send: Sender = urllib_send,
        schedule: Scheduler = _thread_scheduler,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        rng: random.Random | None = None,
    ) -> None:
        env_dir = os.environ.get("ARKRECORD_DATA_DIR")
        self._dir = data_dir or (Path(env_dir) if env_dir else None)
        base = base_url if base_url is not None else os.environ.get("ARKRECORD_STATS_URL", "")
        self._base = base.rstrip("/") if base.rstrip("/") in ALLOWED_BASES else None
        self._send = send
        self._schedule = schedule
        self._clock = clock
        self._rng = rng or random.SystemRandom()
        self._lock = threading.Lock()

    # ---- 状态文件 ----

    def _path(self) -> Path | None:
        return self._dir / STATE_FILE if self._dir else None

    def _load(self) -> dict[str, Any]:
        path = self._path()
        state: dict[str, Any] = {}
        if path and path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                state = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                state = {}
        if not isinstance(state.get("enabled"), bool):
            state["enabled"] = True
        if not isinstance(state.get("deviceId"), str) or not re.fullmatch(r"[0-9a-f]{32}", state["deviceId"]):
            state["deviceId"] = uuid.uuid4().hex
        if not isinstance(state.get("sent"), dict):
            state["sent"] = {}
        return state

    def _save(self, state: dict[str, Any]) -> None:
        path = self._path()
        if not path:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    # ---- 上报 ----

    def _post(self, kind: str, body: dict[str, Any]) -> bool:
        if not self._base:
            return False
        headers = {
            "content-type": "application/json",
            "x-arkrecord-client": "desktop",
            "user-agent": f"ArkRecord-Desktop/{__version__}",
        }
        data = json.dumps(body, separators=(",", ":")).encode()
        try:
            response = self._send("POST", f"{self._base}/api/stats/desktop/{kind}", headers, data, TIMEOUT_S)
        except Exception as error:
            log.info("统计上报失败（%s）：%s", kind, type(error).__name__)
            return False
        if response.status != 204:
            log.info("统计上报失败（%s）：HTTP %s", kind, response.status)
            return False
        return True

    def _mark_sent(self, key: str, day: str) -> None:
        with self._lock:
            state = self._load()
            if not state["enabled"]:
                return
            # 只留今天的记录
            sent = {k: v for k, v in state["sent"].items() if v == day}
            sent[key] = day
            state["sent"] = sent
            self._save(state)

    def _send_later(self, kind: str, body: dict[str, Any], key: str, day: str) -> None:
        """随机延迟后发出的账号、用户上报：发之前再看一次开关和今天报过没有。"""
        with self._lock:
            state = self._load()
            if not state["enabled"] or state["sent"].get(key) == day:
                return
        if self._post(kind, body):
            self._mark_sent(key, day)

    # ---- RPC 方法 ----

    def status(self, params: Params) -> dict[str, Any]:
        """stats.status → {enabled, available}。available 为 false 时（没设置上报地址或数据目录）不会上报。"""
        if params not in (None, {}, []):
            raise RpcError(INVALID_PARAMS, "这个方法不接受参数")
        with self._lock:
            state = self._load()
        return {"enabled": state["enabled"], "available": bool(self._base and self._dir)}

    def set_enabled(self, params: Params) -> dict[str, Any]:
        """stats.setEnabled {enabled} → 关闭后不再发出任何统计请求。"""
        if not isinstance(params, dict) or set(params) != {"enabled"} or not isinstance(params["enabled"], bool):
            raise RpcError(INVALID_PARAMS, "参数应为 {enabled: true/false}")
        with self._lock:
            state = self._load()
            state["enabled"] = params["enabled"]
            if not state["enabled"]:
                state["sent"] = {}
            self._save(state)
        log.info("统计已%s", "开启" if params["enabled"] else "关闭")
        return {"enabled": params["enabled"]}

    def report(self, params: Params) -> dict[str, Any]:
        """stats.report {accounts: [{game, uid}], user?} → 今天还没报过的设备、账号和用户，安排上报（立即返回）。

        accounts 是这台电脑上的真实账号（不含演示账号）。没有账号时，设备记为“没登录”。
        user 是本机的同步识别码（32 位十六进制），开通过云同步才有。
        """
        if (
            not isinstance(params, dict)
            or "accounts" not in params
            or not set(params) <= {"accounts", "user"}
            or not isinstance(params["accounts"], list)
        ):
            raise RpcError(INVALID_PARAMS, "参数应为 {accounts: [{game, uid}], user?}")
        sync_user = params.get("user")
        if sync_user is not None and (not isinstance(sync_user, str) or not SYNC_USER_RE.match(sync_user)):
            raise RpcError(INVALID_PARAMS, "user 应为 32 位十六进制的同步识别码")
        accounts: list[tuple[str, str]] = []
        for item in params["accounts"][:MAX_ACCOUNTS]:
            if not isinstance(item, dict) or set(item) != {"game", "uid"}:
                raise RpcError(INVALID_PARAMS, "accounts 的每一项应为 {game, uid}")
            game, uid = item["game"], item["uid"]
            if game not in GAMES or not isinstance(uid, str) or not UID_RE.match(uid) or uid == "demo":
                continue
            if (game, uid) not in accounts:
                accounts.append((game, uid))

        day = cn_day(self._clock())
        with self._lock:
            state = self._load()
            self._save(state)
            if not state["enabled"] or not self._base or not self._dir:
                return {"scheduled": 0}
            device_due = state["sent"].get("device") != day
            device = device_hash(state["deviceId"])
            later: list[tuple[str, dict[str, Any], str]] = []
            for g, u in accounts:
                hashed = uid_hash(g, u)
                if state["sent"].get(f"uid:{hashed}") != day:
                    later.append(("uid", {"game": g, "hash": hashed}, f"uid:{hashed}"))
            if sync_user is not None:
                hashed = user_hash(sync_user)
                if state["sent"].get(f"user:{hashed}") != day:
                    later.append(("user", {"hash": hashed}, f"user:{hashed}"))

        scheduled = 0
        if device_due:

            def send_device() -> None:
                if self._post("device", {"hash": device, "loggedIn": bool(accounts)}):
                    self._mark_sent("device", day)

            self._schedule(0.0, send_device)
            scheduled += 1
        self._rng.shuffle(later)
        for kind, body, key in later:
            delay = self._rng.uniform(*UID_DELAY_RANGE)
            self._schedule(delay, lambda kind=kind, body=body, key=key: self._send_later(kind, body, key, day))
            scheduled += 1
        return {"scheduled": scheduled}

    def methods(self) -> dict[str, Any]:
        return {"stats.status": self.status, "stats.setEnabled": self.set_enabled, "stats.report": self.report}
