<script setup lang="ts">
/**
 * 原神 / 星铁的“读取”：从游戏缓存读抽卡链接（找不到目录时手动选择）、等待读取（轮询缓存的修改时间）、粘贴链接，
 * 然后由 syncMhy 同步（src/lib/mhy/sync.ts）。请求全部由本机后端直连米哈游官方接口。
 *
 * 读取的状态和操作在 reader.ts，每个游戏一份：切换原神 / 星铁时这个面板是复用的，状态放在这里会串到另一个游戏。
 * 一个游戏在读取时，可以切到另一个游戏同时读取；“等待读取”离开页面后也继续。
 *
 * 抽卡链接里有 authkey，当凭据处理：粘贴框不回显、不保存，交给后端后马上清空；界面上任何地方都不显示链接内容。
 */
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue'
import { MHY_GAME_LABEL, MHY_POOLS, type MhyGame } from '@/lib/mhy/types'
import { mhyRecordName, useMhyReader } from './reader'

const props = defineProps<{ game: MhyGame }>()

const reader = useMhyReader()
const state = computed(() => reader.states[props.game])
const label = computed(() => MHY_GAME_LABEL[props.game])
const recordName = computed(() => mhyRecordName(props.game))
const running = computed(() => state.value.running)
const waiting = computed(() => state.value.waiting)
const progress = computed(() => state.value.progress)
const problem = computed(() => state.value.problem)
const dataDir = computed(() => state.value.dataDir)

// 告诉 reader 现在显示的是哪个游戏：别的游戏读完或出错时才弹提示
watchEffect(() => (reader.shown.value = props.game))
onBeforeUnmount(() => (reader.shown.value = null))

const readFromCache = () => reader.readFromCache(props.game)
const pickDir = () => reader.pickDir(props.game)
const startWaiting = () => reader.startWaiting(props.game)
const stopWaiting = () => reader.stopWaiting(props.game)
const setDir = (value: string | null) => reader.setDir(props.game, value)

// ───── 粘贴链接：不回显、不保存，交给后端后马上清空 ─────
const pasteOpen = ref(false)
const pasteUrl = ref('')
function submitPaste() {
  const url = pasteUrl.value.trim()
  pasteUrl.value = ''
  pasteOpen.value = false
  if (!url) return
  void reader.readUrl(props.game, url)
}
function closePaste(open: boolean) {
  pasteOpen.value = open
  if (!open) pasteUrl.value = ''
}

// ───── 出错时的下一步 ─────
const NEED_OPEN = new Set(['no_link', 'link_expired', 'link_invalid', 'handle_expired', 'wait_timeout'])
const problemTitle = computed(() => {
  const p = problem.value
  if (!p) return ''
  if (p.partial && p.partial.fetched > 0) return '只读取了一部分'
  if (NEED_OPEN.has(p.kind)) return `需要先在游戏里打开${recordName.value}`
  if (p.kind === 'cache_locked') return '游戏正在运行'
  if (p.kind === 'game_not_found') return '没有找到游戏目录'
  if (p.kind === 'rate_limited') return '请求太频繁'
  if (p.kind === 'network') return '网络连接失败'
  return '读取失败'
})
const problemHint = computed(() => {
  const p = problem.value
  if (!p) return ''
  if (NEED_OPEN.has(p.kind)) return `在游戏里打开一次${recordName.value}（翻一页就行），再点“读取”；也可以点“等待读取”，打开后会自动读取。链接大约 24 小时后过期。`
  if (p.kind === 'cache_locked') return '关闭游戏后（启动器可以不关），点下面的按钮重新读取。'
  if (p.kind === 'game_not_found') return '可以手动选择游戏目录（游戏安装目录或游戏数据目录都行），选过之后会记住。'
  if (p.kind === 'rate_limited') return '米哈游的接口限制了请求频率，请等一分钟再试。'
  if (p.kind === 'network') return '请检查网络后再试。'
  return ''
})
/** 中途出错时已经保存的部分 */
const partialText = computed(() => {
  const partial = problem.value?.partial
  if (!partial || partial.fetched === 0) return ''
  const done = partial.pools.filter((p) => p.complete).map((p) => p.name)
  const notDone = partial.pools.filter((p) => !p.complete).map((p) => p.name)
  const pending = MHY_POOLS[props.game].filter((p) => !partial.pools.some((r) => r.type === p.type)).map((p) => p.name)
  const missing = [...notDone, ...pending]
  return `已保存 ${partial.added} 条新记录（${done.join('、') || '没有'}已读完）${missing.length ? `，${missing.join('、')}没读完` : ''}。在游戏里重新打开${recordName.value}后再读取，会接着把剩下的读完。`
})
</script>

<template>
  <div class="space-y-4 rounded-(--ui-radius) border border-default bg-default p-4">
    <div class="flex flex-wrap items-center gap-2">
      <UButton icon="i-lucide-download" label="从游戏缓存读取" :loading="running" :disabled="waiting" @click="readFromCache" />
      <UButton
        v-if="!waiting"
        icon="i-lucide-hourglass"
        label="等待读取"
        color="neutral"
        variant="outline"
        :disabled="running"
        @click="startWaiting"
      />
      <UButton v-else icon="i-lucide-x" label="停止等待" color="neutral" variant="outline" @click="stopWaiting" />
      <UButton icon="i-lucide-clipboard-paste" label="粘贴链接" color="neutral" variant="ghost" :disabled="running" @click="pasteOpen = true" />
    </div>

    <p class="text-sm text-muted">
      先在游戏里打开一次{{ recordName }}，再点“从游戏缓存读取”。ArkRecord 只读取游戏的网页缓存里的抽卡链接，不修改游戏文件；记录由本机直接向米哈游官方接口读取，不经过任何服务器。
    </p>

    <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
      <UIcon name="i-lucide-folder" class="size-4 shrink-0" />
      <template v-if="dataDir">
        <span class="min-w-0 break-all">游戏目录：{{ dataDir }}</span>
        <UButton label="更换" size="xs" variant="link" class="p-0" :disabled="running" @click="pickDir" />
        <UButton label="改回自动查找" size="xs" variant="link" color="neutral" class="p-0" :disabled="running" @click="setDir(null)" />
      </template>
      <template v-else>
        <span>游戏目录：自动查找（读游戏日志）</span>
        <UButton label="手动选择" size="xs" variant="link" class="p-0" :disabled="running" @click="pickDir" />
      </template>
    </div>

    <div v-if="running && progress" class="space-y-2">
      <UProgress animation="carousel" size="sm" />
      <p class="text-sm text-muted">
        {{ progress.stage }}<span v-if="progress.detail"> · {{ progress.detail }}</span>
        <span v-if="progress.fetched"> · 已读到 {{ progress.fetched }} 条新记录</span>
      </p>
    </div>

    <UAlert v-if="waiting" color="info" variant="subtle" icon="i-lucide-hourglass" :title="`正在等待：请在游戏里打开${recordName}`" description="发现新的抽卡链接后会自动读取。最多等 10 分钟。" />

    <UAlert v-if="problem" :color="partialText ? 'warning' : 'error'" variant="subtle" icon="i-lucide-circle-alert" :title="problemTitle">
      <template #description>
        <p>{{ problem.message }}</p>
        <p v-if="partialText" class="mt-1">{{ partialText }}</p>
        <p v-if="problemHint" class="mt-1">{{ problemHint }}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <UButton v-if="NEED_OPEN.has(problem.kind) || partialText" label="等待读取" icon="i-lucide-hourglass" size="xs" @click="startWaiting" />
          <UButton v-if="problem.kind === 'game_not_found'" label="手动选择游戏目录" icon="i-lucide-folder-open" size="xs" @click="pickDir" />
          <UButton v-if="problem.kind === 'cache_locked'" label="关闭游戏后点这里重新读取" icon="i-lucide-refresh-cw" size="xs" :loading="running" @click="readFromCache" />
        </div>
      </template>
    </UAlert>

    <UModal :open="pasteOpen" title="粘贴抽卡链接" :description="`在其他工具里复制的${label}抽卡记录链接`" @update:open="closePaste">
      <template #body>
        <form class="space-y-3" @submit.prevent="submitPaste">
          <UInput
            v-model="pasteUrl"
            type="password"
            autocomplete="off"
            placeholder="https://…（不会显示，也不会保存）"
            class="w-full"
            :ui="{ base: 'font-mono' }"
          />
          <p class="text-xs text-muted">链接里有你的登录凭据（authkey），交给本机后端校验后就从界面上清掉，不会保存，也不会发给除米哈游官方接口以外的地方。</p>
          <div class="flex justify-end">
            <UButton type="submit" label="读取" icon="i-lucide-arrow-right" trailing :disabled="!pasteUrl.trim()" />
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
