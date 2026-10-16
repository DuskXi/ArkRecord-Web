<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { createSnapshot, type ImportSummary, importLegacyAccounts, makeAccountId } from '@/lib/archive'
import { db } from '@/lib/db'
import { formatNumber } from '@/lib/format'
import { LEGACY_APP_PATH, type LegacyAccount, readLegacyLocalStorage } from '@/lib/legacy'
import { loadAkMeta } from '@/lib/meta'
import { APP_VERSION, useAppStore } from '@/stores/app'

/**
 * 新版沿用 ark.kaltsit.dev 域名，旧版留在 localStorage 中的数据可以直接读取。
 * 老用户第一次打开新版时自动导入，并显示进度和结果：
 *   - 导入前自动保存一份快照，旧版的数据原样保留、不删除；
 *   - 旧版保存的登录 token 一并迁移（它本来就保存在这个浏览器里），完成后可以一键清除；
 *   - 同一条记录重复导入不会重复计数，失败时可以重试；
 *   - 旧版仍保留在 /legacy/，遇到问题可以在旧版里手动导出，再到新版导入。
 */
const app = useAppStore()
const open = ref(false)
const phase = ref<'importing' | 'done' | 'error'>('importing')
// shallowRef：旧数据要原样写入 IndexedDB，深层响应式代理无法被结构化克隆（DataCloneError）
const legacy = shallowRef<LegacyAccount[]>([])
const current = ref(0)
const summary = ref<ImportSummary | null>(null)
const error = ref('')
const tokensCleared = ref(false)

const legacyUrl = `${location.host}${LEGACY_APP_PATH}`

const totalPulls = computed(() => legacy.value.reduce((n, a) => n + a.pools.reduce((m, p) => m + p.result.length, 0), 0))
const hasTokens = computed(() => legacy.value.some((a) => a.accountToken))

// 等欢迎窗口关掉之后再开始（第一次访问的顺序：欢迎窗口 → 旧数据迁移 → 统计同意）
let started = false
async function start() {
  if (started) return
  started = true
  if (await db.kv.get('legacyMigrated')) return void (app.legacyStep = 'done')
  legacy.value = readLegacyLocalStorage(localStorage).filter((a) => a.pools.length || a.stone.length || a.recharge.length)
  if (!legacy.value.length) return void (app.legacyStep = 'done')
  open.value = true
  app.legacyStep = 'open'
  await migrate()
}
onMounted(() => {
  watch(
    () => app.welcomeOpen,
    (welcome) => {
      if (!welcome) void start()
    },
    { immediate: true },
  )
})
watch(open, (value) => {
  if (!value && app.legacyStep === 'open') app.legacyStep = 'done'
})

async function migrate() {
  phase.value = 'importing'
  current.value = 0
  error.value = ''
  try {
    await createSnapshot('迁移旧版数据之前', APP_VERSION)
    summary.value = await importLegacyAccounts(legacy.value, await loadAkMeta(), {
      rememberTokens: true,
      onProgress: (index) => (current.value = index),
    })
    current.value = legacy.value.length
    await db.kv.put({ key: 'legacyMigrated', value: Date.now() })
    app.game = 'arknights'
    phase.value = 'done'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    phase.value = 'error'
  }
}

async function clearTokens() {
  const ids = legacy.value.map((a) => makeAccountId('arknights', a.uid))
  await db.accounts.where('id').anyOf(ids).modify((account) => {
    delete account.accountToken
  })
  tokensCleared.value = true
}

async function later() {
  await db.kv.put({ key: 'legacyMigrated', value: 'dismissed' })
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" :dismissible="phase !== 'importing'" :close="phase !== 'importing'" :ui="{ content: 'sm:max-w-lg' }">
    <template #title>
      {{ phase === 'done' ? '旧版数据导入完成' : phase === 'error' ? '旧版数据导入失败' : '发现旧版 ArkRecord 的数据，正在导入…' }}
    </template>
    <template #body>
      <div class="space-y-4 text-sm">
        <p v-if="phase === 'importing'" class="text-muted">
          这个浏览器里保存着旧版的 {{ legacy.length }} 个账号、{{ formatNumber(totalPulls) }} 条寻访记录，正在转换成新版的格式，请不要关闭页面。
        </p>
        <UProgress v-if="phase === 'importing'" :model-value="current" :max="legacy.length" />

        <ul class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <li v-for="(a, i) in legacy" :key="a.uid" class="flex items-center gap-3 px-3 py-2">
            <UIcon
              :name="phase === 'done' || i < current ? 'i-lucide-circle-check' : i === current && phase === 'importing' ? 'i-lucide-loader-circle' : 'i-lucide-circle'"
              class="size-4 shrink-0"
              :class="[phase === 'done' || i < current ? 'text-success' : 'text-dimmed', i === current && phase === 'importing' ? 'animate-spin' : '']"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium text-highlighted">{{ a.nickName }}</span>
              <span class="text-xs text-dimmed">UID {{ a.uid }} · {{ a.channel === 'bilibili' ? 'B 服' : '官服' }}</span>
            </span>
            <span class="font-display text-xs text-muted">{{ formatNumber(a.pools.reduce((n, p) => n + p.result.length, 0)) }} 抽</span>
          </li>
        </ul>

        <div class="rounded-(--ui-radius) border border-default bg-elevated/50 p-3 text-xs leading-relaxed text-muted">
          <p class="flex items-center gap-1.5 font-medium text-highlighted">
            <UIcon name="i-lucide-life-buoy" class="size-3.5" />
            遇到问题时
          </p>
          <p class="mt-1">
            旧版仍然可以在
            <a :href="LEGACY_APP_PATH" target="_blank" rel="noopener" class="font-medium text-primary underline underline-offset-2">{{ legacyUrl }}</a>
            打开，旧数据原样留在浏览器里。如果新版里的记录不对，可以在旧版的“数据管理”里手动导出 JSON，再到新版的“数据”页导入（重复导入不会重复计数）；新版的数据也可以随时在“数据”页导出备份。
          </p>
        </div>

        <template v-if="phase === 'done' && summary">
          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="rounded-(--ui-radius) border border-default p-2">
              <p class="font-display text-lg font-semibold text-highlighted">{{ summary.accounts }}</p>
              <p class="text-xs text-muted">个账号</p>
            </div>
            <div class="rounded-(--ui-radius) border border-default p-2">
              <p class="font-display text-lg font-semibold text-highlighted">{{ formatNumber(summary.pulls) }}</p>
              <p class="text-xs text-muted">条寻访记录</p>
            </div>
            <div class="rounded-(--ui-radius) border border-default p-2">
              <p class="font-display text-lg font-semibold text-highlighted">{{ formatNumber(summary.ledger) }}</p>
              <p class="text-xs text-muted">条源石 / 充值</p>
            </div>
          </div>
          <ul class="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
            <li>旧版的数据没有删除；导入前已自动保存快照，可以在“数据”页恢复。</li>
            <li v-if="hasTokens">
              旧版保存的登录 token 已一并迁移，官服 token 仍有效时可以直接同步新记录。
              <UButton v-if="!tokensCleared" label="不保存 token" size="xs" variant="link" class="p-0" @click="clearTokens" />
              <span v-else class="text-success">已清除。</span>
            </li>
            <li>鹰角只提供最近 90 天的记录；之后点“同步”会把新记录接在旧记录后面。</li>
          </ul>
        </template>

        <p v-if="phase === 'error'" class="rounded-(--ui-radius) border border-error/40 bg-error/5 p-3 text-xs text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <template v-if="phase === 'error'">
          <UButton label="稍后再说" color="neutral" variant="ghost" @click="later" />
          <UButton label="重试" icon="i-lucide-rotate-cw" @click="migrate" />
        </template>
        <UButton v-else-if="phase === 'done'" label="开始使用" icon="i-lucide-arrow-right" @click="open = false" />
        <UButton v-else label="正在导入…" loading disabled />
      </div>
    </template>
  </UModal>
</template>
