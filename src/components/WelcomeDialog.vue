<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { loadDemo } from '@/lib/demo'
import { readLegacyLocalStorage } from '@/lib/legacy'
import { loadAkMeta } from '@/lib/meta'
import { useAppStore } from '@/stores/app'

/** 第一次访问时在屏幕中央介绍网站（只显示一次）；关掉之后才进行旧数据迁移和统计同意 */
const app = useAppStore()
const router = useRouter()

/** 用过旧版的老用户：关掉窗口后会自动导入旧数据 */
const hasLegacy = readLegacyLocalStorage(localStorage).length > 0
const demoLoading = ref(false)

const FEATURES = [
  { icon: 'i-lucide-gauge', title: '保底追踪', text: '现在垫了多少抽、离保底还有多远，定向保底和累计奖励的进度' },
  { icon: 'i-lucide-scroll-text', title: '寻访记录', text: '按十连分组查看，按星级、卡池、干员筛选' },
  { icon: 'i-lucide-git-commit-vertical', title: '时间线与分享', text: '每个 6★ 的来历一目了然，一键生成分享图片' },
  { icon: 'i-lucide-book-user', title: '图鉴', text: '抽到过哪些干员、各抽到几次' },
  { icon: 'i-lucide-gem', title: '源石与充值', text: '明日方舟的源石收支与充值记录' },
  { icon: 'i-lucide-database', title: '数据安全', text: '导入导出、自动快照，旧版数据自动导入' },
]

const ADVANCED = [
  '出金（终末地叫“出红”）抽数分布，和理论分布对比',
  '歪不歪的概率分布：按保底规则精确计算，不是模拟',
  '运气百分位：你比多少玩家更欧',
  '欧非走势、抽卡时段与各时段的出金率',
  '抽卡规划：攒多少抽、有多大把握拿到 UP',
  '纪录：最快出金、最长连歪、最欧的一天',
]

function close() {
  app.closeWelcome()
}

function addAccount() {
  close()
  app.loginOpen = true
}

async function demo() {
  demoLoading.value = true
  try {
    app.selectAccount(await loadDemo(await loadAkMeta()))
    await router.push('/')
  } finally {
    demoLoading.value = false
    close()
  }
}
</script>

<template>
  <UModal
    :open="app.welcomeOpen"
    title="欢迎使用 ArkRecord"
    description="明日方舟 / 明日方舟：终末地 寻访记录的本地存档与分析工具"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="(open: boolean) => !open && close()"
  >
    <template #body>
      <div class="space-y-5 text-sm">
        <p class="leading-relaxed text-muted">
          鹰角官方只能查询最近 90 天的寻访记录。ArkRecord 把每次同步到的记录保存在<b class="text-highlighted">你自己的浏览器</b>里，越攒越全；
          所有分析计算也都在你的浏览器里完成，本站不保存你的任何记录。
        </p>

        <ul class="grid gap-3 sm:grid-cols-2">
          <li v-for="f in FEATURES" :key="f.title" class="flex gap-3">
            <span class="grid size-8 shrink-0 place-items-center rounded-(--ui-radius) bg-primary/10 text-primary">
              <UIcon :name="f.icon" class="size-4" />
            </span>
            <span class="min-w-0">
              <span class="block font-medium text-highlighted">{{ f.title }}</span>
              <span class="block text-xs leading-relaxed text-muted">{{ f.text }}</span>
            </span>
          </li>
        </ul>

        <div class="rounded-(--ui-radius) border border-primary/30 bg-primary/5 p-4">
          <p class="flex items-center gap-1.5 font-medium text-highlighted">
            <UIcon name="i-lucide-telescope" class="size-4 text-primary" />
            高级统计
          </p>
          <ul class="mt-2 grid gap-x-4 gap-y-1 text-xs leading-relaxed text-muted sm:grid-cols-2">
            <li v-for="a in ADVANCED" :key="a" class="flex gap-1.5">
              <UIcon name="i-lucide-check" class="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>{{ a }}</span>
            </li>
          </ul>
        </div>

        <UAlert
          v-if="hasLegacy"
          color="primary"
          variant="subtle"
          icon="i-lucide-history"
          title="发现旧版 ArkRecord 的数据"
          description="关掉这个窗口后会自动导入，旧数据原样保留。"
        />
        <p v-else class="text-xs leading-relaxed text-muted">
          粘贴鹰角通行证的账号 token 就能同步，明日方舟和终末地共用一个通行证；不想登录的话，可以先载入演示数据看看。
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton v-if="hasLegacy" label="开始导入" icon="i-lucide-arrow-right" trailing @click="close" />
        <template v-else>
          <UButton label="先看演示数据" icon="i-lucide-play" color="neutral" variant="outline" :loading="demoLoading" @click="demo" />
          <UButton label="添加账号" icon="i-lucide-plus" @click="addAccount" />
        </template>
      </div>
    </template>
  </UModal>
</template>
