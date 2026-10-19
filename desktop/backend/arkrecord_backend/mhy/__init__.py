"""米哈游（原神、星铁）：读本机游戏缓存里的抽卡链接，直连官方接口拉取抽卡记录。

流程和规则见 docs/desktop/plan.md 的“登录和取数”：只读游戏文件；抽卡链接（含 authkey）只留在本进程内存里，
页面只拿到句柄；请求只发给 shared/upstreams/mhy.json 白名单里的官方接口，不经过任何 Worker。
"""
