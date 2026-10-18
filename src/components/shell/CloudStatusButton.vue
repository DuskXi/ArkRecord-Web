<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { MODE_LABEL, useCloudStore } from '@/stores/cloud'

/**
 * 右上角同步按钮旁的云同步状态：图标表示当前账号的云同步是否开启；
 * 悬停（手机上长按）显示说明；点击转到“数据”页的云同步部分。
 */
const app = useAppStore()
const cloud = useCloudStore()
const router = useRouter()
const route = useRoute()

/** “数据”页云同步部分的锚点（CloudSyncPanel 上的 id） */
const ANCHOR = 'cloud-sync'

const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

const status = computed(() => {
  const account = app.activeAccount
  if (!account) return null
  const entry = cloud.byAccount.get(account.id)
  if (cloud.busy === account.id) return { icon: 'i-lucide-refresh-cw', tone: 'text-primary animate-spin', title: '正在云同步…', text: '点击查看云同步。' }
  if (!entry) {
    if (cloud.available === false) return { icon: 'i-lucide-cloud-off', tone: 'text-dimmed', title: '云同步：暂时不可用', text: '服务器还没有配置云同步。' }
    return {
      icon: 'i-lucide-cloud-off',
      tone: 'text-dimmed',
      title: '云同步：未开启',
      text: '开启后，可以在多个浏览器、多台设备之间合并这个账号的记录；记录在浏览器里加密后才上传，服务器解不开。点击去开启。',
    }
  }
  const mode = MODE_LABEL[entry.state.mode]
  if (!entry.hasKeys) {
    return { icon: 'i-lucide-cloud-alert', tone: 'text-warning', title: '云同步：已开通，这台设备未解锁', text: `${mode}。输入云同步密码（或一键解锁）之后才能同步。点击去解锁。` }
  }
  const last = entry.state.lastSyncAt ? `上次云同步：${dateTime.format(entry.state.lastSyncAt)}。` : '还没有在这台设备上云同步过。'
  const auto = entry.state.requireHg ? '从鹰角同步记录后，会提示你点一下云同步（需要发送鹰角 token）。' : '从鹰角同步记录后会顺带云同步。'
  return { icon: 'i-lucide-cloud-check', tone: 'text-success', title: `云同步：已开启（${mode}）`, text: `${last}${auto}点击查看。` }
})

// ── 手机上长按显示说明（触屏没有悬停，提示框组件也不会在触屏上打开，所以单独画一个气泡）；长按之后的那次点击不跳转 ──
const touchOpen = ref(false)
let pressTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
let longPressed = false

function closeBubble() {
  touchOpen.value = false
  clearTimeout(closeTimer)
  document.removeEventListener('pointerdown', onOutside, true)
}

function onOutside(event: PointerEvent) {
  if (!(event.target instanceof Node) || !root.value?.contains(event.target)) closeBubble()
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType !== 'touch') return
  longPressed = false
  clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    longPressed = true
    touchOpen.value = true
    clearTimeout(closeTimer)
    closeTimer = setTimeout(closeBubble, 5000)
    document.addEventListener('pointerdown', onOutside, true)
  }, 450)
}

function cancelPress() {
  clearTimeout(pressTimer)
}

async function go() {
  if (longPressed) {
    longPressed = false
    return
  }
  closeBubble()
  if (route.path === '/data') document.getElementById(ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  else await router.push({ path: '/data', hash: `#${ANCHOR}` })
}

const root = ref<HTMLElement | null>(null)
watch(() => route.fullPath, closeBubble)

onBeforeUnmount(() => {
  clearTimeout(pressTimer)
  closeBubble()
})
</script>

<template>
  <div v-if="status" ref="root" class="relative">
    <UTooltip :ui="{ content: 'h-auto max-w-72 flex-col items-start gap-0.5 py-1.5 whitespace-normal' }">
      <UButton
        color="neutral"
        variant="ghost"
        square
        :aria-label="`${status.title}。${status.text}`"
        class="select-none [-webkit-touch-callout:none]"
        @pointerdown="onPointerDown"
        @pointerup="cancelPress"
        @pointerleave="cancelPress"
        @pointercancel="cancelPress"
        @contextmenu.prevent
        @click="go"
      >
        <UIcon :name="status.icon" class="size-5" :class="status.tone" />
      </UButton>
      <template #content>
        <p class="font-medium text-highlighted">{{ status.title }}</p>
        <p class="leading-relaxed text-muted">{{ status.text }}</p>
      </template>
    </UTooltip>
    <div
      v-if="touchOpen"
      role="tooltip"
      class="absolute top-full right-0 z-50 mt-2 w-64 rounded-(--ui-radius) bg-default p-2.5 text-xs shadow-lg ring ring-default"
    >
      <p class="font-medium text-highlighted">{{ status.title }}</p>
      <p class="mt-0.5 leading-relaxed text-muted">{{ status.text }}</p>
    </div>
  </div>
</template>
