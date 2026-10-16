#!/usr/bin/env bash
# 重新生成 public/legacy：旧版 ArkRecord（2022–2023，Quasar 版），部署在新版同一域名的 /legacy/ 下。
# 与新版同源，所以旧版仍能读到它留在浏览器里的数据，用户可以在旧版里导出，再到新版导入。
# 旧版代码已经冻结，一般不需要重新生成；产物直接提交在仓库里。
#
# 旧版代码保存在 legacy-v0.1 分支（新版合并进 master 之前的 master）。
#
# 用法：scripts/build-legacy.sh [git ref，默认 origin/legacy-v0.1]
set -euo pipefail

REF=${1:-origin/legacy-v0.1}
ROOT=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git -C "$ROOT" archive "$REF" | tar -x -C "$WORK"
cd "$WORK"

patch() { # 文件 原文 替换；原文不存在时报错，避免静默失效
  grep -qF "$2" "$1" || { echo "找不到要替换的内容：$1: $2" >&2; exit 1; }
  sed -i "s#$(printf '%s' "$2" | sed 's/[#.*/[\]^$]/\\&/g')#$3#g" "$1"
}

# lockfile 中大部分依赖指向 npmmirror，改为官方源（同一个包的 tarball 和校验值相同）
sed -i 's#https://registry.npmmirror.com#https://registry.npmjs.org#g' package-lock.json
# 部署在 /legacy/ 下；背景图原来写的是绝对路径
patch quasar.config.js "      // publicPath: '/'," "      publicPath: '/legacy/',"
patch src/layouts/MainLayout.vue "url(/background.jpg)" "url(/legacy/background.jpg)"

npm ci --no-audit --no-fund
npx quasar build

OUT=dist/spa
# 原背景图 4792×2396、10 MB，缩到 2560 宽（约 0.4 MB）
node -e "
const sharp = require('$ROOT/node_modules/sharp')
sharp('$OUT/background.jpg').resize({ width: 2560, withoutEnlargement: true }).jpeg({ quality: 80, progressive: true, mozjpeg: true })
  .toBuffer().then((b) => require('fs').writeFileSync('$OUT/background.jpg', b))
"
# 旧版需要访问 api.kaltsit.dev、PRTS 等外部地址，不能用新版的 CSP（_headers 中对 /legacy/* 去掉了），
# 在页面里单独声明一份：脚本只允许本站，网络请求和图片允许 https。
CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; base-uri 'self'; form-action 'self'"
sed -i "s#<meta charset=utf-8>#<meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"$CSP\">#" "$OUT/index.html"
grep -q 'Content-Security-Policy' "$OUT/index.html"

rm -rf "$ROOT/public/legacy"
cp -r "$OUT" "$ROOT/public/legacy"
echo "已生成 public/legacy（$(du -sh "$ROOT/public/legacy" | cut -f1)）"
