<script setup lang="ts">
/**
 * UIGF 导入导出（MhyDataPage 的“UIGF 格式”开关打开后才显示）。解析、预览、写入、生成文件都在 src/lib/mhy/uigf.ts；
 * 这里只管选文件、给出预览让用户确认、保存导出的文件。导入只追加记录，不删除、不覆盖已有的。
 * 文件里有 UID：只在本机处理，不上传；导出的文件名不带 UID。
 */
import { computed, ref, shallowRef } from 'vue'
import { dateStamp, downloadFile } from '@/lib/download'
import { formatDate, formatNumber } from '@/lib/format'
import { MHY_GAME_LABEL, type MhyGame } from '@/lib/mhy/types'
import { exportUigf, importUigf, type ParsedUigf, parseUigf, previewUigf, type UigfPreview } from '@/lib/mhy/uigf'
import { selectMhyAccount, useMhyAccounts } from './accounts'

const props = defineProps<{ game: MhyGame }>()
const toast = useToast()
const { accounts, account } = useMhyAccounts(() => props.game)

// ───── 导入 ─────
const fileInput = ref<HTMLInputElement>()
const fileName = ref('')
const parsed = shallowRef<ParsedUigf | null>(null)
const preview = ref<UigfPreview | null>(null)
const previewOpen = ref(false)
const busy = ref(false)
const added = computed(() => preview.value?.items.reduce((n, i) => n + i.added, 0) ?? 0)
const skipText = (reasons: Record<string, number>) =>
  Object.entries(reasons)
    .map(([reason, n]) => `${reason} ${formatNumber(n)} 条`)
    .join('；')

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    const next = parseUigf(JSON.parse(await file.text()))
    parsed.value = next
    preview.value = await previewUigf(next)
    fileName.value = file.name
    previewOpen.value = true
  } catch (error) {
    toast.add({ title: '无法导入这个文件', description: error instanceof Error ? error.message : String(error), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}

async function confirmImport() {
  if (!parsed.value) return
  busy.value = true
  try {
    const result = await importUigf(parsed.value)
    toast.add({
      title: result.added ? `导入完成，新增 ${result.added} 条记录` : '导入完成，没有新记录',
      description: fileName.value,
      color: 'success',
      icon: 'i-lucide-circle-check',
    })
    // 导入了当前游戏的账号、而且之前没有选中的账号时，选中它
    const mine = result.accountIds.find((id) => id.startsWith(`${props.game}:`))
    if (mine && !account.value) selectMhyAccount(props.game, mine)
    closePreview()
  } catch (error) {
    toast.add({ title: '导入失败', description: error instanceof Error ? error.message : String(error), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}

function closePreview() {
  previewOpen.value = false
  parsed.value = null
  preview.value = null
}

// ───── 导出 ─────
const exportAll = ref(false)
const canExport = computed(() => (exportAll.value ? accounts.value.length > 0 : !!account.value))

async function doExport() {
  // 空列表：导出这个游戏的全部账号
  const ids = exportAll.value ? [] : account.value ? [account.value.id] : null
  if (!ids) return
  busy.value = true
  try {
    const json = await exportUigf(props.game, ids)
    downloadFile(`GameRecord_${props.game}_UIGF_${dateStamp()}.json`, JSON.stringify(json, null, 2), 'application/json')
  } catch (error) {
    toast.add({ title: '导出失败', description: error instanceof Error ? error.message : String(error), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-4 border-t border-default pt-4 md:grid-cols-2">
    <div class="space-y-2">
      <p class="text-sm font-medium text-highlighted">导入</p>
      <p class="text-xs text-muted">选择 UIGF 格式的 JSON 文件，先显示会新增多少条，确认后才写入。只追加记录，不删除、不覆盖已有的；文件只在这台电脑上处理。</p>
      <input ref="fileInput" type="file" accept=".json,application/json" class="hidden" @change="onFile" />
      <UButton label="选择文件" icon="i-lucide-upload" size="sm" :loading="busy && !previewOpen" @click="fileInput?.click()" />
    </div>
    <div class="space-y-2">
      <p class="text-sm font-medium text-highlighted">导出</p>
      <p class="text-xs text-muted">把{{ MHY_GAME_LABEL[game] }}的记录导出成 UIGF 格式的 JSON 文件。</p>
      <UCheckbox v-if="accounts.length > 1" v-model="exportAll" label="导出这个游戏的全部账号" />
      <UButton label="导出" icon="i-lucide-download" size="sm" color="neutral" variant="outline" :disabled="!canExport" :loading="busy && !previewOpen" @click="doExport" />
    </div>

    <UModal v-model:open="previewOpen" title="导入预览" :description="fileName" :dismissible="!busy" @update:open="(open: boolean) => !open && closePreview()">
      <template #body>
        <div v-if="preview" class="space-y-3 text-sm">
          <p class="text-xs text-muted">{{ preview.format }}<template v-if="preview.exportApp"> · 由 {{ preview.exportApp }} 导出</template></p>
          <p v-if="!preview.items.length" class="text-muted">文件里没有能导入的原神或星铁记录。</p>
          <ul v-else class="divide-y divide-default rounded-(--ui-radius) border border-default">
            <li v-for="item in preview.items" :key="item.accountId" class="space-y-1 px-3 py-2">
              <p class="font-medium text-highlighted">
                {{ MHY_GAME_LABEL[item.game] }} · UID {{ item.uid }}
                <UBadge v-if="!item.accountExists" label="新账号" color="primary" variant="subtle" size="sm" class="ml-1" />
              </p>
              <p class="text-xs text-muted">
                共 {{ formatNumber(item.total) }} 条：新增 <b class="text-highlighted">{{ formatNumber(item.added) }}</b>，已有
                {{ formatNumber(item.duplicate) }}<template v-if="item.skipped">，跳过 {{ formatNumber(item.skipped) }}</template>
                <template v-if="item.firstTs && item.lastTs"> · {{ formatDate(item.firstTs) }} — {{ formatDate(item.lastTs) }}</template>
              </p>
              <p v-if="item.skipped" class="text-xs text-muted">跳过的原因：{{ skipText(item.skippedReasons) }}</p>
              <p v-for="w in item.warnings" :key="w" class="text-xs text-warning">{{ w }}</p>
            </li>
          </ul>
          <p v-if="preview.unsupported.length" class="text-xs text-muted">不支持、会跳过的部分：{{ preview.unsupported.join('、') }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="取消" color="neutral" variant="ghost" :disabled="busy" @click="closePreview" />
          <UButton :label="added ? `导入 ${formatNumber(added)} 条` : '没有新记录'" icon="i-lucide-check" :loading="busy" :disabled="!added" @click="confirmImport" />
        </div>
      </template>
    </UModal>
  </div>
</template>
