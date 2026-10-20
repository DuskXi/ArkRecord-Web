"""安装包里后端的入口（PyInstaller 打包用）：和 python -m arkrecord_backend 一样。"""

import sys

from arkrecord_backend.app import main

if __name__ == "__main__":
    sys.exit(main())
