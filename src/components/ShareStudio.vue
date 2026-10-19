<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDate, formatNumber, formatPercent } from '@/lib/format'
import { luckLabel } from '@/lib/stats/analyze'
import { useAppStore } from '@/stores/app'
import { useRecords } from '@/composables/useRecords'

/**
 * 分享卡片：在页面里渲染一张设计好的卡片，再用 snapdom 转成 PNG。
 * 头像来自本站同源路径，不会因为跨域导致图片丢失。
 */
const open = defineModel<boolean>('open', { default: false })
const app = useAppStore()
const records = useRecords()
const toast = useToast()

const showName = ref(true)
const count = ref(18)
const card = ref<HTMLElement | null>(null)
const imageUrl = ref<string | null>(null)
const blob = ref<Blob | null>(null)
const rendering = ref(false)

const a = computed(() => records.analysis)
const hits = computed(() => a.value.hits.toReversed().slice(0, count.value))
const luck = computed(() => luckLabel(a.value.luck))
const canShareFiles = computed(() => {
  if (!blob.value || typeof navigator.canShare !== 'function') return false
  return navigator.canShare({ files: [new File([blob.value], 'arkrecord.png', { type: 'image/png' })] })
})

async function render() {
  if (!card.value) return
  rendering.value = true
  try {
    await document.fonts.ready
    await Promise.all([...card.value.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)))
    const { snapdom } = await import('@zumer/snapdom')
    const bg = getComputedStyle(card.value).backgroundColor
    const capture = await snapdom(card.value, { scale: 2, backgroundColor: bg, embedFonts: true })
    const result = (await capture.toBlob({ format: 'png' })) as Blob
    blob.value = result
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = URL.createObjectURL(result)
  } catch (e) {
    toast.add({ title: '生成图片失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    rendering.value = false
  }
}

watch(open, async (value) => {
  if (value) {
    imageUrl.value = null
    await nextTick()
  }
})

function download() {
  if (!imageUrl.value) return
  const link = document.createElement('a')
  link.href = imageUrl.value
  link.download = `ArkRecord_${formatDate(Date.now()).replaceAll('/', '')}.png`
  link.click()
}

async function share() {
  if (!blob.value) return
  try {
    await navigator.share({ files: [new File([blob.value], 'arkrecord.png', { type: 'image/png' })], title: 'ArkRecord' })
  } catch {
    // 用户取消
  }
}

async function copy() {
  if (!blob.value) return
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob.value })])
    toast.add({ title: '已复制到剪贴板', color: 'success' })
  } catch {
    toast.add({ title: '浏览器不允许复制图片，请使用下载', color: 'warning' })
  }
}
</script>

<template>
  <UModal v-model:open="open" title="分享卡片" description="生成一张总结图片，可以下载、复制或直接分享。" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <div class="flex flex-wrap items-center gap-4 pb-4">
        <USwitch v-model="showName" label="显示昵称" />
        <div class="flex items-center gap-2 text-sm">
          <span class="text-muted">6★ 数量</span>
          <UFieldGroup>
            <UButton v-for="n in [12, 18, 30]" :key="n" :label="String(n)" size="xs" :variant="count === n ? 'soft' : 'outline'" :color="count === n ? 'primary' : 'neutral'" @click="count = n" />
          </UFieldGroup>
        </div>
      </div>

      <div class="overflow-x-auto">
        <!-- 要导出的卡片 -->
        <div ref="card" class="grid-backdrop w-[640px] bg-default p-8 text-default">
          <div class="flex items-start justify-between">
            <div>
              <p class="eyebrow">{{ records.profile.reportTitle }} · HEADHUNTING REPORT</p>
              <p class="mt-1 text-2xl font-semibold text-highlighted">{{ showName ? app.activeAccount?.nickName : records.profile.label + '寻访总结' }}</p>
              <p v-if="a.firstTs && a.lastTs" class="mt-0.5 font-display text-xs text-dimmed">{{ formatDate(a.firstTs) }} — {{ formatDate(a.lastTs) }}</p>
            </div>
            <div class="text-right">
              <p class="eyebrow">LUCK</p>
              <p class="font-display text-3xl font-semibold" style="color: var(--color-rarity-6)">{{ a.luck === null ? '—' : formatPercent(a.luck, 0) }}</p>
              <p class="text-xs text-muted">{{ luck.text }}</p>
            </div>
          </div>

          <div class="mt-6 grid grid-cols-4 gap-3">
            <div v-for="item in [
              { label: 'PULLS', value: formatNumber(a.total) },
              { label: '6★', value: String(a.stars[6]) },
              { label: 'AVG / 6★', value: a.avgPerSix ? a.avgPerSix.toFixed(1) : '—' },
              { label: 'UP RATE', value: a.upTotal ? formatPercent(a.upWins / a.upTotal, 0) : '—' },
            ]" :key="item.label" class="rounded-(--ui-radius) border border-default bg-default/80 p-3">
              <p class="eyebrow">{{ item.label }}</p>
              <p class="mt-1 font-display text-2xl font-semibold text-highlighted">{{ item.value }}</p>
            </div>
          </div>

          <div class="mt-6 grid grid-cols-6 gap-3">
            <div v-for="h in hits" :key="h.event.key">
              <div class="relative">
                <CharAvatar :char-id="h.event.itemId" :name="h.event.name" :star="6" :size="84" :game="records.game" />
                <span class="absolute top-1 right-1 rounded-sm bg-black/65 px-1 font-display text-[11px] font-semibold text-white">{{ h.pity }}</span>
              </div>
              <p class="mt-1 truncate text-[11px] font-medium text-highlighted">{{ h.event.name }}</p>
            </div>
          </div>

          <div class="mt-6 flex items-center justify-between border-t border-default pt-3">
            <p class="font-display text-[11px] tracking-[0.2em] text-dimmed">ARKRECORD</p>
            <p class="font-display text-[11px] text-dimmed">ark.kaltsit.dev · {{ formatDate(Date.now()) }}</p>
          </div>
        </div>
      </div>

      <div v-if="imageUrl" class="mt-4 rounded-(--ui-radius) border border-default p-2">
        <p class="mb-2 text-xs text-muted">预览（手机上可以长按图片保存）</p>
        <img :src="imageUrl" alt="分享卡片" class="w-full" />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton label="生成图片" icon="i-lucide-image" :loading="rendering" @click="render" />
        <UButton v-if="imageUrl" label="下载" icon="i-lucide-download" color="neutral" variant="outline" @click="download" />
        <UButton v-if="imageUrl" label="复制" icon="i-lucide-copy" color="neutral" variant="outline" @click="copy" />
        <UButton v-if="canShareFiles" label="分享" icon="i-lucide-share-2" color="neutral" variant="outline" @click="share" />
      </div>
    </template>
  </UModal>
</template>
