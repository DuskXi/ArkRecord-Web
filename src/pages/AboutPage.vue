<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AuditDialog from '@/components/AuditDialog.vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { formatNumber } from '@/lib/format'
import { BUILD_COMMIT, HG_VERIFY_URL, SECURITY_URL } from '@/lib/cloud/links'
import { LEGACY_APP_PATH } from '@/lib/legacy'
import { APP_VERSION, useAppStore } from '@/stores/app'
import { IMAGE_SOURCES } from '../../worker/images'
import { UPSTREAMS } from '../../worker/upstreams'

const app = useAppStore()
const route = useRoute()

/** 线上代码审计弹窗；/about#audit 直接打开（更新公告里的链接） */
const auditOpen = ref(false)
watch(
  () => route.hash,
  (hash) => {
    if (hash === '#audit') auditOpen.value = true
  },
  { immediate: true },
)
const upstreams = Object.values(UPSTREAMS)
const imageSources = Object.values(IMAGE_SOURCES)

const sources = [
  { name: '鹰角网络', desc: '寻访记录、卡池信息（经本站转发，见上表）', url: 'https://www.hypergryph.com/' },
  { name: 'PRTS', desc: '明日方舟干员名单、UP 名单、卡池名称、头像（构建时获取并镜像到本站）；新干员头像经本站图片缓存', url: 'https://prts.wiki/' },
  { name: 'Kengxxiao/ArknightsGameData', desc: '卡池类型与开放时间；干员名单的备用来源（构建时获取）', url: 'https://github.com/Kengxxiao/ArknightsGameData' },
  { name: 'yuanyan3060/ArknightsGameResource', desc: '干员头像的备用来源（构建时镜像到本站）', url: 'https://github.com/yuanyan3060/ArknightsGameResource' },
  { name: '555me/beyondGameData', desc: '终末地卡池类型、UP 名单、角色与武器名称（构建时获取）', url: 'https://github.com/555me/beyondGameData' },
  { name: '明日方舟终末地 BWIKI', desc: '终末地角色头像与武器图标（构建时镜像到本站）', url: 'https://wiki.biligame.com/zmd/' },
  { name: '森空岛', desc: 'BWIKI 暂缺的终末地角色头像（构建时镜像到本站；地址索引来自 cmyyx/cep）', url: 'https://wiki.skland.com/endfield' },
]
</script>

<template>
  <PageShell id="about" title="关于" eyebrow="ABOUT & TRANSPARENCY" :require-account="false" :sync="false" :scoped="false">
    <div class="space-y-10">
      <section class="flex flex-col gap-4 rounded-(--ui-radius) border border-primary/40 bg-primary/5 p-5 sm:flex-row sm:items-center">
        <UIcon name="i-lucide-badge-check" class="size-9 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-highlighted">这个网站运行的，就是公开的源码吗？</p>
          <p class="mt-1 text-sm leading-relaxed text-muted">每次部署都会留下任何人都能核对的公开记录，每天自动核对一次。点开看看是怎么保证的、现在运行的是哪个版本。</p>
        </div>
        <UButton label="线上代码审计" icon="i-lucide-shield-check" size="lg" class="shrink-0 justify-center" @click="auditOpen = true" />
      </section>

      <section class="grid gap-3 md:grid-cols-3">
        <div v-for="item in [
          { icon: 'i-lucide-hard-drive', title: '数据只在你的浏览器里', desc: '寻访记录、统计结果、账号 token 都保存在本机的 IndexedDB 中，本站没有用户系统。开启云同步时，服务器只保存你在浏览器里加密好的密文。' },
          { icon: 'i-lucide-cpu', title: '计算全部在本地完成', desc: '保底、运气百分位、各种图表都由你的浏览器计算，不依赖任何人的数据。' },
          { icon: 'i-lucide-route', title: '转发只为绕过浏览器限制', desc: '鹰角的接口不允许网页直接调用，本站的 Worker 只做转发：token 放在请求体里，不出现在网址中；不记录、不存储，也不对其他网站开放。' },
        ]" :key="item.title" class="rounded-(--ui-radius) border border-default p-5">
          <UIcon :name="item.icon" class="size-5 text-primary" />
          <p class="mt-3 font-semibold text-highlighted">{{ item.title }}</p>
          <p class="mt-1 text-sm leading-relaxed text-muted">{{ item.desc }}</p>
        </div>
      </section>

      <section>
        <SectionHeader index="01" eyebrow="FORWARDED HOSTS" title="转发清单" />
        <p class="mb-3 text-sm text-muted">
          以下是本站 Worker 允许转发的全部上游，以及需要转发的原因。清单与源码中的白名单（<code class="font-mono text-xs">shared/upstreams/hg.json</code>）是同一份数据。
        </p>
        <div class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <div v-for="u in upstreams" :key="u.host" class="p-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="font-mono text-sm text-highlighted">{{ u.host }}</p>
              <p class="text-xs text-muted">{{ u.purpose }}</p>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-muted">原因：{{ u.reason }}</p>
            <p class="mt-1 font-mono text-[11px] text-dimmed">
              {{ u.routes.map((r) => `${r.method} ${r.path}`).join(' · ') }}
            </p>
          </div>
        </div>
        <p class="mt-4 mb-3 text-sm text-muted">
          图片缓存（<code class="font-mono text-xs">worker/images.ts</code>）：大部分头像在构建时已镜像为本站静态文件；
          构建时拿不到的少量图片由 Worker 取回并缓存在 Cloudflare 30 天，同一张图在每个机房只向来源站请求一次，且只供本站页面使用。
        </p>
        <div class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <div v-for="s in imageSources" :key="s.host" class="flex flex-wrap items-baseline justify-between gap-2 p-4">
            <p class="font-mono text-sm text-highlighted">{{ s.host }}</p>
            <p class="text-xs text-muted">{{ s.purpose }}</p>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader index="02" eyebrow="DATA SOURCES" title="数据来源" />
        <ul class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <li v-for="s in sources" :key="s.name" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <ULink :to="s.url" target="_blank" class="text-sm font-medium text-highlighted hover:text-primary">{{ s.name }}</ULink>
            <span class="text-xs text-muted">{{ s.desc }}</span>
          </li>
        </ul>
      </section>

      <section id="usage" class="scroll-mt-4">
        <SectionHeader index="03" eyebrow="USAGE STATISTICS" title="统计与 Cookie">
          <USwitch
            :model-value="app.consent === 'all'"
            label="参与统计"
            @update:model-value="(v: boolean) => app.setConsent(v ? 'all' : 'essential')"
          />
        </SectionHeader>
        <div v-if="app.usage" class="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div v-for="item in [
            { label: '累计用户', value: app.usage.users },
            { label: '明日方舟', value: app.usage.games.arknights },
            { label: '终末地', value: app.usage.games.endfield },
            { label: '今日活跃', value: app.usage.today },
            { label: '今日新增', value: app.usage.todayNew },
            { label: '本月活跃', value: app.usage.month },
          ]" :key="item.label" class="rounded-(--ui-radius) border border-default p-3">
            <p class="text-xs text-muted">{{ item.label }}</p>
            <p class="font-display text-xl font-semibold text-highlighted">{{ formatNumber(item.value) }}</p>
          </div>
        </div>
        <div class="space-y-2 rounded-(--ui-radius) border border-default p-4 text-sm leading-relaxed text-muted">
          <p>本站不用 Cookie 追踪访客。第一次访问时会询问你是否参与统计：“全部接受”会启用下面两项统计，“仅必要”只保留网站功能本身需要的本地存储（你自己的寻访记录、账号和设置，只存在你的浏览器里）。做出选择之前，两项统计都不启用。</p>
          <p>本站统计使用人数，用来了解有多少人在用、是否值得继续维护。为了让你知情，这里说明全部细节：</p>
          <ul class="list-disc space-y-1 pl-5">
            <li>
              <b class="text-highlighted">上报什么</b>：每天最多一次，只有四个开关——这个浏览器是否第一次来、本月是否第一次来、这个浏览器里有哪些游戏的账号（演示账号不算）、其中哪些是新加的。
              不包含账号、UID、昵称、寻访记录，也不生成或上传任何可以识别你的标识符；“是否来过”记在你自己浏览器的 localStorage 里。
            </li>
            <li><b class="text-highlighted">保存什么</b>：服务端只有几个计数器（累计人数、每天和每月的人数），没有逐条的访问记录，不保存 IP。</li>
            <li><b class="text-highlighted">局限</b>：同一个人换浏览器、或清除了浏览器数据，会被算作新用户，所以“累计用户”是浏览器数，略多于实际人数。</li>
            <li>
              <b class="text-highlighted">Cloudflare Web Analytics</b>：同样只在“全部接受”后加载，统计页面访问量（不使用 Cookie、不跨站追踪），用于站点运维。
            </li>
            <li>
              <b class="text-highlighted">修改</b>：随时可以用右上角的“参与统计”开关修改；关闭后本浏览器不再发出统计上报，Cloudflare 的统计脚本在刷新页面后停止。
              也可以<UButton label="重新查看网站介绍" variant="link" size="xs" class="p-0 align-baseline" @click="app.welcomeOpen = true" />。
            </li>
            <li>实现见源码 <code class="font-mono text-xs">src/lib/usage.ts</code> 与 <code class="font-mono text-xs">worker/stats.ts</code>。</li>
            <li>
              <b class="text-highlighted">站内反馈</b>（与统计无关）：只在你在“反馈”页主动提交时发送，保存在本站的 Cloudflare 存储里，只有作者能看到；
              内容只有你填写的文字和联系方式，以及网站版本、当前游戏，不记录 IP、账号或 UID。见 <code class="font-mono text-xs">worker/feedback.ts</code>。
            </li>
          </ul>
        </div>
      </section>

      <section>
        <SectionHeader index="04" eyebrow="CLOUD SYNC & SECURITY" title="云同步与安全" />
        <div class="space-y-2 rounded-(--ui-radius) border border-default p-4 text-sm leading-relaxed text-muted">
          <p>云同步是可选的，在“数据”页按账号开通。完整说明见 <ULink :to="SECURITY_URL" target="_blank" class="text-primary">安全说明（SECURITY.md）</ULink>。</p>
          <ul class="list-disc space-y-1 pl-5">
            <li>记录在你的浏览器里用云同步密码派生的钥匙加密后才上传；服务器只保存密文和密码的加盐散列，解不开数据，也不保存密码。</li>
            <li>只知道 UID 的人拿不到任何东西，连密文也拿不到；同一个账号连续输错 5 次后开始退避，与对方有多少 IP 无关。</li>
            <li>密码无法找回：忘记密码只能用数据最全的浏览器覆盖云端。本地数据始终不受影响。</li>
            <li>
              也可以选无密码模式（不推荐）：不用记密码，每次云同步都用鹰角 token 核实账号。当前实现中，token 只在服务器核实请求时存在于内存里，不会出现在日志和硬盘里（见下一条的代码）；代价是解开数据的钥匙服务器也算得出来，本站运营者和拿到你有效鹰角 token 的人技术上能读取你的云端记录。随时可以切回密码模式。
            </li>
            <li>
              检测云端状态、开通、覆盖和双重验证时，服务器会用鹰角 token 查询角色绑定列表，核实 UID 属于你，然后立即丢弃。只在你点击按钮、并在确认窗口里点“确认发送”之后才会发送；token 放在请求体里，不出现在网址和请求头里，服务器不写入存储、不写日志。全部代码在
              <ULink :to="HG_VERIFY_URL" target="_blank" class="font-mono text-xs text-primary">worker/hg-verify.ts</ULink>，
              链接指向线上正在运行的版本（{{ BUILD_COMMIT === 'dev' ? '开发版' : BUILD_COMMIT.slice(0, 7) }}）。
            </li>
          </ul>
        </div>
      </section>

      <section class="text-xs leading-relaxed text-muted">
        <p>
          ArkRecord {{ APP_VERSION }}（<ULink to="/announcements" class="text-primary">更新公告</ULink>）· 开源于
          <ULink to="https://github.com/DuskXi/ArkRecord-Web" target="_blank" class="text-primary">GitHub</ULink>
          。本站为玩家自制工具，与鹰角网络无关。游戏内的名称与图像版权归鹰角网络所有。
        </p>
        <p class="mt-1">
          给 AI 助手和搜索引擎的说明：<a href="/llms.txt" target="_blank" rel="noopener" class="text-primary">/llms.txt</a>（完整版
          <a href="/llms-full.txt" target="_blank" rel="noopener" class="text-primary">/llms-full.txt</a>）。
        </p>
        <p class="mt-1">
          旧版 ArkRecord（v0.1）仍然可以在
          <a :href="LEGACY_APP_PATH" target="_blank" rel="noopener" class="text-primary">{{ LEGACY_APP_PATH }}</a>
          访问，用于查看和导出旧版留在浏览器里的数据。
        </p>
      </section>
    </div>
    <AuditDialog v-model:open="auditOpen" />
  </PageShell>
</template>
