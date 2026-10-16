<script setup lang="ts">
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { APP_VERSION } from '@/stores/app'
import { IMAGE_SOURCES } from '../../worker/images'
import { UPSTREAMS } from '../../worker/upstreams'

const upstreams = Object.values(UPSTREAMS)
const imageSources = Object.values(IMAGE_SOURCES)

const sources = [
  { name: '鹰角网络', desc: '寻访记录、卡池信息（经本站转发，见上表）', url: 'https://www.hypergryph.com/' },
  { name: 'Kengxxiao/ArknightsGameData', desc: '干员表与卡池表（构建时获取）', url: 'https://github.com/Kengxxiao/ArknightsGameData' },
  { name: 'yuanyan3060/ArknightsGameResource', desc: '干员头像（构建时镜像到本站）', url: 'https://github.com/yuanyan3060/ArknightsGameResource' },
  { name: 'PRTS', desc: 'UP 名单（构建时获取）；本站镜像里还没有的新干员头像（经本站图片缓存）', url: 'https://prts.wiki/' },
  { name: '555me/beyondGameData', desc: '终末地卡池类型、UP 名单、角色与武器名称（构建时获取）', url: 'https://github.com/555me/beyondGameData' },
]
</script>

<template>
  <PageShell id="about" title="关于" eyebrow="ABOUT & TRANSPARENCY" :require-account="false" :sync="false">
    <div class="space-y-10">
      <section class="grid gap-3 md:grid-cols-3">
        <div v-for="item in [
          { icon: 'i-lucide-hard-drive', title: '数据只在你的浏览器里', desc: '寻访记录、统计结果、账号 token 都保存在本机的 IndexedDB 中，本站没有任何数据库或用户系统。' },
          { icon: 'i-lucide-cpu', title: '计算全部在本地完成', desc: '保底、运气百分位、各种图表都由你的浏览器计算，不依赖任何人的数据。' },
          { icon: 'i-lucide-route', title: '转发只为绕过浏览器限制', desc: '鹰角的接口不允许网页直接调用，本站的 Worker 只做原样转发：不解析、不记录、不存储，也不对其他网站开放。' },
        ]" :key="item.title" class="rounded-(--ui-radius) border border-default p-5">
          <UIcon :name="item.icon" class="size-5 text-primary" />
          <p class="mt-3 font-semibold text-highlighted">{{ item.title }}</p>
          <p class="mt-1 text-sm leading-relaxed text-muted">{{ item.desc }}</p>
        </div>
      </section>

      <section>
        <SectionHeader index="01" eyebrow="FORWARDED HOSTS" title="转发清单" />
        <p class="mb-3 text-sm text-muted">
          以下是本站 Worker 允许转发的全部上游，以及需要转发的原因。清单与源码中的白名单（<code class="font-mono text-xs">worker/upstreams.ts</code>）是同一份数据。
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

      <section class="text-xs leading-relaxed text-muted">
        <p>
          ArkRecord {{ APP_VERSION }} · 开源于
          <ULink to="https://github.com/DuskXi/ArkRecord-Web" target="_blank" class="text-primary">GitHub</ULink>
          。本站为玩家自制工具，与鹰角网络无关。游戏内的名称与图像版权归鹰角网络所有。
        </p>
      </section>
    </div>
  </PageShell>
</template>
