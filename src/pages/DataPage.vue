<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import {
  buildExport,
  createSnapshot,
  deleteAccountData,
  type ExportFile,
  importAnonymousLegacy,
  importExportFile,
  importLegacyAccounts,
  isExportFile,
} from '@/lib/archive'
import { db, requestPersistence } from '@/lib/db'
import { DEMO_ACCOUNT_ID, loadDemo } from '@/lib/demo'
import { formatDateTime, formatNumber } from '@/lib/format'
import { isLegacyExport, type LegacyExport, parseLegacyExport, readLegacyLocalStorage } from '@/lib/legacy'
import { loadAkMeta } from '@/lib/meta'
import { type Account, GAME_LABEL } from '@/lib/types'
import { APP_VERSION, useAppStore } from '@/stores/app'
import { useRecordsStore } from '@/stores/records'
import { useSyncStore } from '@/stores/sync'

const app = useAppStore()
const sync = useSyncStore()
const records = useRecordsStore()
const toast = useToast()

const counts = useLiveQuery(
  async () => {
    const result: Record<string, number> = {}
    for (const a of await db.accounts.toArray()) {
      result[a.id] = await (a.game === 'arknights' ? db.akPulls : db.efPulls).where('accountId').equals(a.id).count()
    }
    return result
  },
  [],
  {} as Record<string, number>,
)
// Dexie 的 Collection.reverse()，不是数组方法
// oxlint-disable-next-line unicorn/no-array-reverse
const snapshots = useLiveQuery(() => db.snapshots.orderBy('createdAt').reverse().toArray(), [], [])

// ── 存储状态 ──
const persisted = ref<boolean | null>(null)
const usage = ref<string>('')
onMounted(async () => {
  persisted.value = (await navigator.storage?.persisted?.()) ?? null
  const est = await navigator.storage?.estimate?.()
  if (est?.usage !== undefined) usage.value = `${(est.usage / 1024 / 1024).toFixed(1)} MB`
})
async function persist() {
  persisted.value = await requestPersistence()
  toast.add({
    title: persisted.value ? '已开启持久化存储' : '浏览器没有允许持久化',
    description: persisted.value ? '浏览器不会在空间不足时自动清理本站数据。' : '可以把本站加入书签或安装为应用后再试。',
    color: persisted.value ? 'success' : 'warning',
  })
}

// ── 导入 ──
const pendingLegacy = ref<LegacyExport | null>(null)
const anonymousTarget = ref<string>()
const legacyLocal = computed(() => readLegacyLocalStorage(localStorage))

function onUpload(value: unknown) {
  const file = Array.isArray(value) ? value[0] : value
  if (file instanceof File) void onFile(file)
}

function onDeleteDialog(open: boolean) {
  if (!open) confirmDelete.value = null
}

async function onFile(file: File | null | undefined) {
  if (!file) return
  try {
    const json = JSON.parse(await file.text()) as unknown
    if (isExportFile(json)) {
      await createSnapshot(`导入 ${file.name} 之前`, APP_VERSION)
      const s = await importExportFile(json)
      toast.add({ title: '导入完成', description: `${s.accounts} 个账号，新增 ${s.pulls} 条记录`, color: 'success' })
    } else if (isLegacyExport(json)) {
      const parsed = parseLegacyExport(json as Record<string, unknown>)
      if (parsed.accounts.length) {
        await createSnapshot(`导入 ${file.name} 之前`, APP_VERSION)
        const s = await importLegacyAccounts(parsed.accounts, await loadAkMeta())
        toast.add({ title: '旧版数据导入完成', description: `${s.accounts} 个账号，新增 ${s.pulls} 条寻访记录`, color: 'success' })
      }
      if (parsed.anonymous.official || parsed.anonymous.bilibili) pendingLegacy.value = parsed
    } else {
      toast.add({ title: '无法识别的文件', description: '支持新版导出的 JSON 和旧版 ArkRecord 导出的 JSON。', color: 'error' })
    }
  } catch (e) {
    toast.add({ title: '导入失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}

const arknightsAccounts = computed(() => app.accounts.filter((a) => a.game === 'arknights' && a.id !== DEMO_ACCOUNT_ID))
async function importAnonymous() {
  const target = app.accounts.find((a) => a.id === anonymousTarget.value)
  const data = pendingLegacy.value?.anonymous
  if (!target || !data) return
  await createSnapshot('导入旧版无 uid 数据之前', APP_VERSION)
  const meta = await loadAkMeta()
  let pulls = 0
  for (const part of [data.official, data.bilibili]) if (part) pulls += (await importAnonymousLegacy(target, part, meta)).pulls
  toast.add({ title: '导入完成', description: `新增 ${pulls} 条寻访记录到 ${target.nickName}`, color: 'success' })
  pendingLegacy.value = null
}

async function migrateLocal() {
  await createSnapshot('迁移旧版数据之前', APP_VERSION)
  const s = await importLegacyAccounts(legacyLocal.value, await loadAkMeta(), { rememberTokens: true })
  await db.kv.put({ key: 'legacyMigrated', value: Date.now() })
  toast.add({ title: '迁移完成', description: `${s.accounts} 个账号，新增 ${s.pulls} 条寻访记录`, color: 'success' })
}

// ── 导出 ──
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const stamp = () => new Date().toISOString().slice(0, 10)

async function exportJson() {
  download(`ArkRecord_${stamp()}.json`, JSON.stringify(await buildExport(APP_VERSION), null, 2), 'application/json')
}
function exportCsv() {
  const header = '时间,卡池,干员,星级,NEW\n'
  const lines = records.events.map((e) =>
    [formatDateTime(e.ts), e.poolName, e.name, e.star, e.isNew ? '是' : ''].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','),
  )
  download(`ArkRecord_${app.activeAccount?.nickName ?? ''}_${stamp()}.csv`, `﻿${header}${lines.join('\n')}`, 'text/csv')
}

// ── 快照 ──
async function restoreSnapshot(payload: string) {
  await createSnapshot('恢复快照之前', APP_VERSION)
  const s = await importExportFile(JSON.parse(payload) as ExportFile)
  toast.add({ title: '已从快照恢复', description: `新增 ${s.pulls} 条记录`, color: 'success' })
}

// ── 账号 ──
const confirmDelete = ref<Account | null>(null)
async function removeAccount() {
  if (!confirmDelete.value) return
  await createSnapshot(`删除 ${confirmDelete.value.nickName} 之前`, APP_VERSION)
  await deleteAccountData(confirmDelete.value.id)
  confirmDelete.value = null
}
async function forgetToken(a: Account) {
  await db.accounts.update(a.id, { accountToken: undefined })
  toast.add({ title: '已清除保存的 token', color: 'neutral' })
}

// ── 演示数据 ──
const demoLoading = ref(false)
async function demo() {
  demoLoading.value = true
  try {
    const account = await loadDemo(await loadAkMeta())
    app.selectAccount(account)
    toast.add({ title: '已载入演示数据', description: '演示账号与真实数据分开存放，可以随时删除。', color: 'success' })
  } finally {
    demoLoading.value = false
  }
}
</script>

<template>
  <PageShell id="data" title="数据" eyebrow="DATA CENTER" :require-account="false">
    <div class="space-y-10">
      <section>
        <SectionHeader index="01" eyebrow="ACCOUNTS" title="账号">
          <UButton label="添加账号" icon="i-lucide-user-plus" @click="app.loginOpen = true" />
        </SectionHeader>
        <div v-if="app.accounts.length" class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <div v-for="a in app.accounts" :key="a.id" class="flex flex-wrap items-center gap-3 p-4">
            <UBadge :label="GAME_LABEL[a.game]" :color="a.game === 'arknights' ? 'primary' : 'warning'" variant="subtle" />
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-highlighted">{{ a.nickName }}</p>
              <p class="text-xs text-muted">
                UID {{ a.uid }}{{ a.channelName ? ` · ${a.channelName}` : '' }} · {{ formatNumber(counts[a.id] ?? 0) }} 条记录 ·
                {{ a.lastSyncAt ? `上次同步 ${formatDateTime(a.lastSyncAt)}` : '尚未同步' }}
              </p>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <template v-if="a.id !== DEMO_ACCOUNT_ID">
                <UButton label="同步" icon="i-lucide-refresh-cw" size="sm" variant="soft" :loading="sync.running" @click="sync.sync(a)" />
                <UTooltip text="重新读取全部 90 天记录（用于补漏）">
                  <UButton label="完整同步" size="sm" color="neutral" variant="ghost" :disabled="sync.running" @click="sync.sync(a, { full: true })" />
                </UTooltip>
                <UButton v-if="a.accountToken" label="清除 token" size="sm" color="neutral" variant="ghost" @click="forgetToken(a)" />
              </template>
              <UButton icon="i-lucide-trash-2" size="sm" color="error" variant="ghost" aria-label="删除账号" @click="confirmDelete = a" />
            </div>
          </div>
        </div>
        <UEmpty
          v-else
          variant="naked"
          icon="i-lucide-users"
          title="还没有账号"
          description="添加鹰角通行证账号，或先载入演示数据看看效果。"
          :actions="[{ label: '载入演示数据', icon: 'i-lucide-flask-conical', color: 'neutral', variant: 'outline', onClick: demo, loading: demoLoading }]"
        />
      </section>

      <section>
        <SectionHeader index="02" eyebrow="IMPORT" title="导入" />
        <div class="grid gap-3 lg:grid-cols-2">
          <UFileUpload
            accept=".json,application/json"
            label="拖入或选择 JSON 文件"
            description="支持新版导出文件，以及旧版 ArkRecord 导出的数据"
            icon="i-lucide-file-json"
            class="min-h-40"
            :model-value="null"
            @update:model-value="onUpload"
          />
          <div class="space-y-3">
            <UAlert
              v-if="legacyLocal.length"
              icon="i-lucide-history"
              color="primary"
              variant="subtle"
              title="这个浏览器里有旧版 ArkRecord 的数据"
              :description="`${legacyLocal.length} 个账号。迁移不会删除旧数据，可以重复执行。`"
              :actions="[{ label: '迁移', onClick: migrateLocal }]"
            />
            <div v-if="pendingLegacy" class="space-y-2 rounded-(--ui-radius) border border-default p-4">
              <p class="text-sm font-medium text-highlighted">这份旧数据没有记录 uid，请选择要导入到哪个账号</p>
              <USelect
                v-model="anonymousTarget"
                :items="arknightsAccounts.map((a) => ({ label: `${a.nickName}（${a.uid}）`, value: a.id }))"
                placeholder="选择明日方舟账号"
                class="w-full"
              />
              <div class="flex justify-end gap-2">
                <UButton label="取消" color="neutral" variant="ghost" @click="pendingLegacy = null" />
                <UButton label="导入" :disabled="!anonymousTarget" @click="importAnonymous" />
              </div>
            </div>
            <p class="text-xs text-muted">导入之前会自动保存一份快照，导入只会新增记录，不会覆盖已有记录。</p>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader index="03" eyebrow="EXPORT" title="导出" />
        <div class="flex flex-wrap gap-2">
          <UButton label="导出全部（JSON）" icon="i-lucide-download" :disabled="!app.accounts.length" @click="exportJson" />
          <UButton
            label="导出当前账号（CSV）"
            icon="i-lucide-sheet"
            color="neutral"
            variant="outline"
            :disabled="!records.events.length"
            @click="exportCsv"
          />
        </div>
        <p class="mt-2 text-xs text-muted">JSON 保留接口原始字段，可以完整导入回来；导出文件不包含 token。</p>
      </section>

      <section>
        <SectionHeader index="04" eyebrow="SNAPSHOTS" title="快照" />
        <div v-if="snapshots.length" class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <div v-for="s in snapshots" :key="s.id" class="flex items-center gap-3 px-4 py-2.5">
            <UIcon name="i-lucide-camera" class="size-4 text-dimmed" />
            <span class="min-w-0 flex-1 truncate text-sm">{{ s.reason }}</span>
            <span class="font-display text-xs text-muted">{{ formatDateTime(s.createdAt) }}</span>
            <UButton label="恢复" size="xs" color="neutral" variant="outline" @click="restoreSnapshot(s.payload)" />
            <UButton icon="i-lucide-download" size="xs" color="neutral" variant="ghost" aria-label="下载快照" @click="download(`ArkRecord_snapshot_${s.id}.json`, s.payload, 'application/json')" />
          </div>
        </div>
        <p v-else class="text-sm text-muted">导入、迁移、删除之前会自动保存快照，最多保留 10 份。</p>
      </section>

      <section>
        <SectionHeader index="05" eyebrow="STORAGE" title="存储" />
        <div class="flex flex-wrap items-center gap-3 rounded-(--ui-radius) border border-default p-4">
          <UIcon :name="persisted ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'" class="size-5" :class="persisted ? 'text-success' : 'text-warning'" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-highlighted">{{ persisted ? '持久化存储已开启' : '未开启持久化存储' }}</p>
            <p class="text-xs text-muted">所有数据只保存在这个浏览器里{{ usage ? `，当前占用 ${usage}` : '' }}。清理浏览器数据会删除它们，记得定期导出备份。</p>
          </div>
          <UButton v-if="!persisted" label="开启" size="sm" @click="persist" />
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <UButton label="载入演示数据" icon="i-lucide-flask-conical" color="neutral" variant="outline" size="sm" :loading="demoLoading" @click="demo" />
        </div>
      </section>
    </div>

    <UModal :open="!!confirmDelete" title="删除账号数据" @update:open="onDeleteDialog">
      <template #body>
        <p class="text-sm">
          将删除 <b>{{ confirmDelete?.nickName }}</b> 在本浏览器中的全部记录。删除前会自动保存一份快照，可以在“快照”中恢复。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="取消" color="neutral" variant="ghost" @click="confirmDelete = null" />
          <UButton label="删除" color="error" icon="i-lucide-trash-2" @click="removeAccount" />
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
