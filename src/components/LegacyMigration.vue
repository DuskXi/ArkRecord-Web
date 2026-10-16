<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { createSnapshot, importLegacyAccounts } from '@/lib/archive'
import { db } from '@/lib/db'
import { type LegacyAccount, readLegacyLocalStorage } from '@/lib/legacy'
import { loadAkMeta } from '@/lib/meta'
import { APP_VERSION, useAppStore } from '@/stores/app'

/**
 * 新版沿用 ark.kaltsit.dev 域名，旧版留在 localStorage 中的数据可以直接读取。
 * 首次打开时提示迁移；迁移后保留旧数据不删除，以防万一。
 */
const app = useAppStore()
const toast = useToast()
const open = ref(false)
const legacy = ref<LegacyAccount[]>([])
const keepTokens = ref(true)
const working = ref(false)

onMounted(async () => {
  if (await db.kv.get('legacyMigrated')) return
  legacy.value = readLegacyLocalStorage(localStorage)
  open.value = legacy.value.some((a) => a.pools.length || a.stone.length || a.recharge.length)
})

async function migrate() {
  working.value = true
  try {
    await createSnapshot('迁移旧版数据之前', APP_VERSION)
    const summary = await importLegacyAccounts(legacy.value, await loadAkMeta(), { rememberTokens: keepTokens.value })
    await db.kv.put({ key: 'legacyMigrated', value: Date.now() })
    app.game = 'arknights'
    toast.add({
      title: '旧版数据迁移完成',
      description: `${summary.accounts} 个账号，${summary.pulls} 条寻访记录，${summary.ledger} 条源石 / 充值记录`,
      color: 'success',
      icon: 'i-lucide-circle-check',
    })
    open.value = false
  } catch (e) {
    toast.add({ title: '迁移失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    working.value = false
  }
}

async function dismiss() {
  await db.kv.put({ key: 'legacyMigrated', value: 'dismissed' })
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" title="发现旧版 ArkRecord 的数据" :dismissible="false" :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <div class="space-y-4 text-sm">
        <p class="text-muted">新版改用新的数据格式和统计方式。可以把旧版保存在这个浏览器里的记录迁移过来，旧数据不会被删除。</p>
        <ul class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <li v-for="a in legacy" :key="a.uid" class="flex items-center justify-between gap-3 px-3 py-2">
            <span class="min-w-0">
              <span class="block truncate font-medium text-highlighted">{{ a.nickName }}</span>
              <span class="text-xs text-dimmed">UID {{ a.uid }} · {{ a.channel === 'bilibili' ? 'B 服' : '官服' }}</span>
            </span>
            <span class="font-display text-xs text-muted">{{ a.pools.reduce((n, p) => n + p.result.length, 0) }} 抽</span>
          </li>
        </ul>
        <USwitch v-model="keepTokens" label="同时保存旧版的登录 token" description="官服 token 若仍有效，可以直接同步新记录。" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="暂不迁移" color="neutral" variant="ghost" @click="dismiss" />
        <UButton label="迁移" icon="i-lucide-arrow-right-left" :loading="working" @click="migrate" />
      </div>
    </template>
  </UModal>
</template>
