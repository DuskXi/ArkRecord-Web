<script setup lang="ts">
/**
 * 导入森空岛 App 的干员列表截图：在这台设备上识别（不上传），逐张核对，保存为“截图时的状态”（roster.ts）。
 * 认名字有两道保险：OCR 认错时用字形比对纠正（identify.ts）；把握不大或者认不出的，由用户搜索选择。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { rarityTextVar } from '@/lib/format'
import { mergeRoster, type RosterInput, type ScreenshotTime, screenshotTime } from '@/lib/roster'
import type { NameCandidate } from '@/lib/screenshot/names'
import type { RecognizeProgress, RecognizedCard, ScreenshotRecognizer } from '@/lib/screenshot/recognize'
import { useAppStore } from '@/stores/app'
import { useRecordsStore } from '@/stores/records'

const open = defineModel<boolean>('open', { default: false })

const app = useAppStore()
const records = useRecordsStore()
const toast = useToast()

const game = computed(() => records.game)
const isEf = computed(() => game.value === 'endfield')

/** 候选名字：游戏里全部可以拥有的干员（只按名字认，星级从游戏数据里查） */
const candidates = computed<NameCandidate[]>(() => {
  const seen = new Set<string>()
  if (isEf.value) {
    return Object.entries(app.efMeta?.items ?? {})
      .filter(([id, item]) => id.startsWith('chr_') && !seen.has(item.n) && seen.add(item.n))
      .map(([id, item]) => ({ id, name: item.n, rarity: item.r }))
  }
  return Object.entries(app.meta?.chars ?? {})
    .filter(([, c]) => !c.x && !seen.has(c.n) && seen.add(c.n))
    .map(([id, c]) => ({ id, name: c.n, rarity: c.r }))
})
const byId = computed(() => new Map(candidates.value.map((c) => [c.id, c])))
const selectItems = computed(() =>
  candidates.value.toSorted((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh')).map((c) => ({ label: c.name, value: c.id, suffix: `${c.rarity}★` })),
)
const potentialItems = [0, 1, 2, 3, 4, 5].map((p) => ({ label: p === 5 ? '潜能 5（满）' : `潜能 ${p}`, value: p }))

// ── 选择截图 ──
interface Shot {
  id: number
  file: File
  time: number
  timeSource: ScreenshotTime['source']
  error?: string
  cards?: RecognizedCard[]
  small?: boolean
}
const shots = ref<Shot[]>([])
let nextShot = 1
const step = ref<'select' | 'working' | 'review'>('select')

async function addFiles(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of input.files ?? []) {
    const t = await screenshotTime(file)
    shots.value.push({ id: nextShot++, file, time: t.ts, timeSource: t.source })
  }
  input.value = ''
}
function removeShot(id: number) {
  shots.value = shots.value.filter((s) => s.id !== id)
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** datetime-local 输入框用的本地时间 */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
function setTime(shot: Shot, value: string) {
  const ts = new Date(value).getTime()
  if (Number.isFinite(ts)) {
    shot.time = ts
    shot.timeSource = 'filename'
  }
}
/** 和截图时间输入框一致，用这台设备的时区显示 */
function formatLocal(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const TIME_SOURCE: Record<ScreenshotTime['source'], string> = { filename: '', exif: '来自图片信息', file: '来自文件时间，可能不准，请核对' }

// ── 识别 ──
const recognizer = shallowRef<ScreenshotRecognizer | null>(null)
const progress = ref<{ shot: number; shots: number; text: string; value: number | null }>({ shot: 0, shots: 0, text: '', value: null })
const STAGE: Record<RecognizeProgress['stage'], string> = {
  decode: '读取图片',
  cards: '寻找干员卡片',
  'ocr-load': '加载文字识别（第一次约 3 MB，之后从浏览器缓存读取）',
  ocr: '识别名字',
  names: '比对干员名单',
}

async function start() {
  if (!shots.value.length) return
  step.value = 'working'
  const { ScreenshotRecognizer } = await import('@/lib/screenshot/recognize')
  recognizer.value?.dispose()
  const r = new ScreenshotRecognizer(isEf.value ? 'endfield' : 'arknights', candidates.value)
  recognizer.value = r
  const list = shots.value.toSorted((a, b) => a.time - b.time)
  for (const [i, shot] of list.entries()) {
    if (recognizer.value !== r) return
    shot.error = undefined
    try {
      const result = await r.recognize(shot.file, (p) => {
        progress.value = {
          shot: i + 1,
          shots: list.length,
          text: `${STAGE[p.stage]}${p.stage === 'ocr' && p.total ? ` ${p.done! + 1}/${p.total}` : ''}`,
          value: p.total ? (p.done ?? 0) / p.total : null,
        }
      })
      shot.cards = result.cards
      shot.small = result.cardWidth > 0 && result.cardWidth < 90
      if (!result.cards.length) shot.error = '没有找到干员卡片：请上传森空岛 App 的干员列表截图'
    } catch (error) {
      if (recognizer.value !== r) return
      shot.error = error instanceof Error ? error.message : String(error)
    }
  }
  buildRows()
  step.value = 'review'
}

// ── 核对 ──
interface Row {
  key: string
  shot: Shot
  card: RecognizedCard
  choice: string | undefined
  potential: number | undefined
  include: boolean
  /** 用户改过或者确认过 */
  touched: boolean
}
const rows = ref<Row[]>([])
const filter = ref<'attention' | 'all'>('attention')

function needsAttention(row: Row): 'unknown' | 'conflict' | 'check' | null {
  if (!row.include) return null
  if (!row.choice) return 'unknown'
  if (sameShot.value.has(row.key)) return 'conflict'
  if (superseded.value.has(row.key)) return null
  if (row.touched) return null
  if (row.card.confidence === 'low' || !row.card.candidate || row.card.candidate.id !== row.choice) return 'check'
  if (isEf.value && (row.potential === undefined || row.card.potentialConfidence === 'low')) return 'check'
  return null
}

function buildRows() {
  const out: Row[] = []
  for (const shot of shots.value) {
    for (const card of shot.cards ?? []) {
      out.push({
        key: `${shot.id}:${card.index}`,
        shot,
        card,
        choice: card.candidate?.id,
        potential: card.potential ?? undefined,
        include: true,
        touched: false,
      })
    }
  }
  // 需要处理的排在前面（只在开始核对时排一次，改动时不跳动）
  const rank = (r: Row) => (!r.choice ? 0 : r.card.confidence === 'low' || (isEf.value && r.card.potentialConfidence === 'low') ? 1 : 2)
  rows.value = out.toSorted((a, b) => rank(a) - rank(b) || a.shot.time - b.shot.time || a.card.index - b.card.index)
  filter.value = rows.value.some((r) => rank(r) < 2) ? 'attention' : 'all'
}

/** 同一张截图里两张卡片选了同一名干员：一定有一张选错了，改正之前不能保存 */
const sameShot = computed(() => {
  const seen = new Map<string, Row[]>()
  for (const r of rows.value) {
    if (!r.include || !r.choice) continue
    const key = `${r.shot.id}:${r.choice}`
    seen.set(key, [...(seen.get(key) ?? []), r])
  }
  return new Set([...seen.values()].filter((list) => list.length > 1).flatMap((list) => list.map((r) => r.key)))
})
/** 几张截图有重叠，同一名干员出现在不同截图里：用截图时间最新的那张，其余的不保存 */
const superseded = computed(() => {
  const latest = new Map<string, Row>()
  for (const r of rows.value) {
    if (!r.include || !r.choice || sameShot.value.has(r.key)) continue
    const prev = latest.get(r.choice)
    if (!prev || r.shot.time > prev.shot.time) latest.set(r.choice, r)
  }
  const out = new Set<string>()
  for (const r of rows.value) {
    if (r.include && r.choice && !sameShot.value.has(r.key) && latest.get(r.choice) !== r) out.add(r.key)
  }
  return out
})

const counts = computed(() => {
  let unknown = 0
  let check = 0
  for (const r of rows.value) {
    const a = needsAttention(r)
    if (a === 'unknown') unknown++
    else if (a) check++
  }
  const included = rows.value.filter((r) => r.include).length
  return { total: rows.value.length, included, saving: included - superseded.value.size, unknown, check }
})
const shown = computed(() => (filter.value === 'all' ? rows.value : rows.value.filter((r) => needsAttention(r) || r.touched)))

function choose(row: Row, id: string | undefined) {
  row.choice = id
  row.touched = true
}
function setPotential(row: Row, p: number | undefined) {
  row.potential = p
  row.touched = true
}
function confirmRow(row: Row) {
  row.touched = true
}

function statusOf(row: Row): { label: string; color: 'success' | 'warning' | 'error' | 'neutral' } {
  if (!row.include) return { label: '不导入', color: 'neutral' }
  const a = needsAttention(row)
  if (a === 'unknown') return { label: '没认出', color: 'error' }
  if (a === 'conflict') return { label: '重复', color: 'error' }
  if (a === 'check') return { label: '请确认', color: 'warning' }
  if (superseded.value.has(row.key)) return { label: '用更新的截图', color: 'neutral' }
  return { label: row.touched ? '已确认' : '有把握', color: 'success' }
}
function why(row: Row): string {
  const parts: string[] = []
  if (row.card.ocr) parts.push(`识别到的文字：${row.card.ocr}`)
  if (!row.card.candidate) parts.push('没有对上任何干员，请搜索选择，或者选择“不导入”')
  else if (row.card.confidence === 'low') parts.push(`猜测是“${row.card.candidate.name}”，把握不大`)
  if (isEf.value && row.card.potentialConfidence === 'low') parts.push('潜能看不太清（截图被压缩过？）')
  if (sameShot.value.has(row.key)) parts.push('这张截图里另一张卡片也选了这名干员，请改正其中一张')
  else if (superseded.value.has(row.key)) parts.push('更新的截图里也有这名干员，保存时用更新的那张')
  return parts.join('；')
}

// ── 保存 ──
const saving = ref(false)
const canSave = computed(
  () => counts.value.included > 0 && !sameShot.value.size && rows.value.every((r) => !r.include || (r.choice && (!isEf.value || r.potential !== undefined))),
)

async function save() {
  const accountId = records.accountId
  if (!accountId || !canSave.value) return
  saving.value = true
  try {
    const items: RosterInput[] = rows.value
      .filter((r) => r.include && r.choice && !superseded.value.has(r.key))
      .map((r) => {
        const potential = isEf.value ? (r.potential ?? 0) : null
        return {
          itemId: r.choice!,
          name: byId.value.get(r.choice!)?.name ?? r.choice!,
          potential,
          copies: potential === null ? null : potential + 1,
          observedAt: r.shot.time,
          source: 'screenshot' as const,
        }
      })
    const s = await mergeRoster(accountId, items)
    const parts = [s.added && `新增 ${s.added}`, s.updated && `更新 ${s.updated}`, s.unchanged && `${s.unchanged} 名和之前导入的一样`, s.older && `${s.older} 名已有更新的截图，没有覆盖`].filter(Boolean)
    toast.add({ title: '已保存', description: parts.join('，') || '没有变化', color: 'success' })
    close()
  } finally {
    saving.value = false
  }
}

function reset() {
  recognizer.value?.dispose()
  recognizer.value = null
  shots.value = []
  rows.value = []
  step.value = 'select'
}
function close() {
  open.value = false
}
watch(open, (v) => {
  if (!v) reset()
})
onBeforeUnmount(() => recognizer.value?.dispose())

const failed = computed(() => shots.value.filter((s) => s.error))
const smallShots = computed(() => shots.value.filter((s) => s.small))
</script>

<template>
  <UModal
    v-model:open="open"
    title="导入森空岛截图"
    :description="isEf ? '识别干员和潜能，补全寻访记录统计不到的部分' : '识别拥有的干员，补全寻访记录统计不到的部分'"
    :ui="{ content: 'sm:max-w-3xl' }"
    :dismissible="step !== 'working'"
  >
    <template #body>
      <!-- 选择截图 -->
      <div v-if="step === 'select'" class="space-y-4 text-sm">
        <ol class="list-decimal space-y-1 pl-5 text-muted">
          <li>
            在森空岛 App 打开{{ isEf ? '终末地的“干员”列表' : '明日方舟的“干员资产”' }}，截图。干员多时可以截长图，或者分几张截。
          </li>
          <li>选择截图。识别全部在这台设备上完成，截图不会上传。</li>
          <li>核对识别结果：认不出、把握不大的会排在前面，可以搜索选择正确的干员。</li>
        </ol>
        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-clock"
          title="截图时间很重要"
          description="保存的是截图那一刻的状态；截图之后又抽到的，会按寻访记录自动加上，不需要重新截图。同一张截图重复导入不会重复计算。时间从文件名读取，读不出时请在下面核对。"
        />
        <label
          class="flex cursor-pointer flex-col items-center gap-2 rounded-(--ui-radius) border border-dashed border-default p-6 text-center hover:bg-elevated/50"
        >
          <UIcon name="i-lucide-image-plus" class="size-8 text-muted" />
          <span class="font-medium text-highlighted">选择截图</span>
          <span class="text-xs text-muted">PNG / JPEG，可以多选</span>
          <input type="file" accept="image/*" multiple class="sr-only" @change="addFiles" />
        </label>
        <ul v-if="shots.length" class="space-y-2">
          <li v-for="s in shots" :key="s.id" class="flex flex-wrap items-center gap-2 rounded-(--ui-radius) border border-default p-2">
            <UIcon name="i-lucide-image" class="size-4 shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate text-xs" :title="s.file.name">{{ s.file.name }}</span>
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-muted">截图时间</span>
              <UInput
                type="datetime-local"
                step="1"
                size="xs"
                :model-value="toLocalInput(s.time)"
                :color="s.timeSource === 'file' ? 'warning' : 'neutral'"
                :highlight="s.timeSource === 'file'"
                @update:model-value="(v: string) => setTime(s, v)"
              />
            </div>
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="移除" @click="removeShot(s.id)" />
            <p v-if="TIME_SOURCE[s.timeSource]" class="w-full pl-6 text-[11px] text-warning">{{ TIME_SOURCE[s.timeSource] }}</p>
          </li>
        </ul>
      </div>

      <!-- 识别中 -->
      <div v-else-if="step === 'working'" class="space-y-3 py-6 text-center text-sm">
        <UIcon name="i-lucide-scan-text" class="size-8 animate-pulse text-primary" />
        <p class="font-medium text-highlighted">正在识别第 {{ progress.shot }} / {{ progress.shots }} 张</p>
        <p class="text-muted">{{ progress.text }}</p>
        <UProgress :model-value="progress.value === null ? null : Math.round(progress.value * 100)" :max="100" size="sm" class="mx-auto max-w-sm" />
      </div>

      <!-- 核对 -->
      <div v-else class="space-y-3 text-sm">
        <UAlert
          v-for="s in failed"
          :key="s.id"
          color="error"
          variant="subtle"
          icon="i-lucide-image-off"
          :title="s.file.name"
          :description="s.error"
        />
        <UAlert
          v-if="smallShots.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-zoom-in"
          title="截图分辨率偏低"
          description="卡片太小，识别结果都请核对。用原图（不要经过聊天软件压缩）效果会好很多。"
        />
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p class="text-muted">
            找到 <b class="text-highlighted">{{ counts.total }}</b> 张卡片
            <template v-if="counts.unknown">，<b class="text-error">{{ counts.unknown }}</b> 张没认出</template>
            <template v-if="counts.check">，<b class="text-warning">{{ counts.check }}</b> 张请确认</template>
          </p>
          <UTabs
            v-model="filter"
            :items="[
              { label: '需要处理', value: 'attention' },
              { label: '全部', value: 'all' },
            ]"
            :content="false"
            size="xs"
            class="ml-auto"
          />
        </div>
        <p v-if="!shown.length" class="py-6 text-center text-muted">
          {{ counts.total ? '都认出来了，没有需要处理的。可以切到“全部”看一遍。' : '没有识别到干员卡片。' }}
        </p>
        <ul class="space-y-2">
          <li
            v-for="r in shown"
            :key="r.key"
            class="flex gap-3 rounded-(--ui-radius) border p-2"
            :class="needsAttention(r) === 'unknown' || needsAttention(r) === 'conflict' ? 'border-error/50' : needsAttention(r) === 'check' ? 'border-warning/50' : 'border-default'"
          >
            <img :src="r.card.thumb" alt="" class="h-24 w-auto shrink-0 rounded-sm object-contain" :class="r.include ? '' : 'opacity-40 grayscale'" />
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="flex flex-wrap items-center gap-1.5">
                <UBadge :label="statusOf(r).label" :color="statusOf(r).color" variant="subtle" size="sm" />
                <span v-if="r.choice && byId.get(r.choice)" class="text-xs font-medium" :style="{ color: rarityTextVar(byId.get(r.choice)!.rarity) }">
                  {{ byId.get(r.choice)!.rarity }}★
                </span>
                <span class="ml-auto text-[11px] text-dimmed">{{ formatLocal(r.shot.time) }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <USelectMenu
                  :model-value="r.choice"
                  :items="selectItems"
                  value-key="value"
                  :search-input="{ placeholder: '输入名字搜索', icon: 'i-lucide-search' }"
                  virtualize
                  placeholder="选择干员"
                  size="sm"
                  class="w-44"
                  :disabled="!r.include"
                  @update:model-value="(v: string | undefined) => choose(r, v)"
                />
                <USelect
                  v-if="isEf"
                  :model-value="r.potential"
                  :items="potentialItems"
                  placeholder="潜能"
                  size="sm"
                  class="w-32"
                  :color="r.card.potentialConfidence === 'low' && !r.touched ? 'warning' : 'neutral'"
                  :highlight="r.card.potentialConfidence === 'low' && !r.touched"
                  :disabled="!r.include"
                  @update:model-value="(v: number | undefined) => setPotential(r, v)"
                />
                <UButton
                  v-if="needsAttention(r) === 'check'"
                  label="没错"
                  icon="i-lucide-check"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  @click="confirmRow(r)"
                />
                <USwitch v-model="r.include" size="xs" label="导入" class="ml-auto" />
              </div>
              <p v-if="why(r)" class="text-[11px] leading-snug text-muted">{{ why(r) }}</p>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-end gap-2">
        <template v-if="step === 'select'">
          <UButton label="取消" color="neutral" variant="ghost" @click="close" />
          <UButton label="开始识别" icon="i-lucide-scan-text" :disabled="!shots.length || !candidates.length" @click="start" />
        </template>
        <template v-else-if="step === 'working'">
          <UButton label="取消" color="neutral" variant="ghost" @click="reset" />
        </template>
        <template v-else>
          <p v-if="sameShot.size" class="mr-auto text-xs text-error">同一张截图里有卡片选了同一名干员，请改正</p>
          <p v-else-if="!canSave && counts.included" class="mr-auto text-xs text-warning">还有没选干员{{ isEf ? '或潜能' : '' }}的卡片：请选择，或者关掉“导入”</p>
          <UButton label="重新选择截图" color="neutral" variant="ghost" @click="reset" />
          <UButton :label="`保存 ${counts.saving} 名干员`" icon="i-lucide-save" :loading="saving" :disabled="!canSave" @click="save" />
        </template>
      </div>
    </template>
  </UModal>
</template>
