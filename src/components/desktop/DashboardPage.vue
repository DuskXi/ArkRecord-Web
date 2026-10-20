<script setup lang="ts">
/**
 * 桌面版的四款游戏总览（侧边栏厂商切换最前面的“总览”，路由 /home，见 src/platform/desktop.ts）。只在桌面版里。
 * 每款游戏一张卡片：本机的账号、记录条数、上次同步，点开进那款游戏。
 */
import { useRouter } from 'vue-router'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { formatDateTime, formatNumber } from '@/lib/format'
import type { Game } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { type AnyGame, DESKTOP_GAMES, type DesktopGame, type LocalCounts, localCounts } from './games'

const app = useAppStore()
const router = useRouter()
const counts = useLiveQuery(localCounts, [], {} as Partial<Record<AnyGame, LocalCounts>>)

/** 鹰角两款共用鹰角的页面，先切到那款游戏；米哈游两款各有自己的页面 */
function open(game: DesktopGame) {
  if (game.vendor === '鹰角') app.game = game.id as Game
  void router.push(game.to)
}
</script>

<template>
  <PageShell id="dashboard" title="总览" eyebrow="ALL GAMES" :require-account="false" :sync="false" :scoped="false">
    <div class="space-y-8">
      <section>
        <SectionHeader index="01" eyebrow="GAMES" title="四款游戏" />
        <div class="grid gap-3 sm:grid-cols-2">
          <button
            v-for="game in DESKTOP_GAMES"
            :key="game.id"
            type="button"
            class="rounded-(--ui-radius) border border-default bg-default p-5 text-left transition-colors hover:border-primary/50 hover:bg-elevated/40"
            @click="open(game)"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="eyebrow">{{ game.vendor }}</p>
                <p class="mt-0.5 truncate text-lg font-semibold text-highlighted">{{ game.label }}</p>
              </div>
              <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0 text-dimmed" />
            </div>
            <template v-if="counts[game.id]?.accounts">
              <p class="mt-3 font-display text-3xl font-semibold text-highlighted">
                {{ formatNumber(counts[game.id]!.pulls) }} <span class="text-sm font-normal text-muted">条记录</span>
              </p>
              <p class="mt-1 text-xs text-muted">
                {{ counts[game.id]!.accounts }} 个账号<template v-if="counts[game.id]!.lastSyncAt"> · 上次同步 {{ formatDateTime(counts[game.id]!.lastSyncAt!) }}</template>
              </p>
            </template>
            <p v-else class="mt-3 text-sm text-muted">还没有记录，点开去{{ game.vendor === '鹰角' ? '添加账号' : '读取' }}</p>
          </button>
        </div>
      </section>
    </div>
  </PageShell>
</template>
