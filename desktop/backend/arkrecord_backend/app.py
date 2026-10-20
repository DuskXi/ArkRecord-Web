"""后端入口：设置 stdio 和日志，注册方法，开始处理请求。"""

from __future__ import annotations

import io
import logging
import os
import platform
import sys
import threading
from typing import Any

from . import PROTOCOL_VERSION, __version__
from .bili import BiliGuard
from .hg import HgClient
from .images import Images
from .mhy.service import MhyService
from .redact import RedactingFormatter
from .rpc import Handler, Params, no_params, serve
from .stats import Stats
from .wikiicons import WikiIcons


def ping(params: Params) -> dict[str, Any]:
    no_params(params)
    return {"pong": True, "protocol": PROTOCOL_VERSION, "backend": __version__, "python": platform.python_version()}


def build_methods(
    hg: HgClient | None = None,
    mhy: MhyService | None = None,
    stats: Stats | None = None,
    images: Images | None = None,
    icons: WikiIcons | None = None,
) -> dict[str, Handler]:
    # BWIKI 的图标和图片共用节奏和退避
    guard = BiliGuard()
    hg_client: list[HgClient] = [hg] if hg else []
    hg_lock = threading.Lock()

    def hg_request(params: Params) -> Any:
        # 第一次调用时才读白名单文件：文件有问题也不影响 ping
        with hg_lock:
            if not hg_client:
                hg_client.append(HgClient())
        return hg_client[0].request(params)

    return {
        "ping": ping,
        "hg.request": hg_request,
        **(mhy or MhyService()).methods(),
        **(stats or Stats()).methods(),
        **(images or Images(guard=guard)).methods(),
        **(icons or WikiIcons(guard=guard)).methods(),
    }


def _setup_logging(stream: io.TextIOBase | Any) -> None:
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.environ.get("ARKRECORD_LOG_LEVEL", "INFO").upper())


def main() -> int:
    # Windows 上 stdio 默认不是 UTF-8（中文系统是 GBK），统一成 UTF-8；输出的换行固定为 \n
    stdin: Any = sys.stdin
    stdout: Any = sys.stdout
    stderr: Any = sys.stderr
    stdin.reconfigure(encoding="utf-8", errors="replace")
    stdout.reconfigure(encoding="utf-8", newline="\n")
    stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

    # 协议只走原来的 stdout；其他代码误用 print 时输出到 stderr，不会混进协议
    protocol_out = stdout
    sys.stdout = stderr

    _setup_logging(stderr)
    logging.getLogger(__name__).info("后端已启动：backend %s，协议 %s", __version__, PROTOCOL_VERSION)
    # 图片（BWIKI 的要排队）单独用一组线程，不占读取记录等其他方法的线程
    serve(build_methods(), stdin, protocol_out, lanes={"img.fetch": 4})
    return 0
