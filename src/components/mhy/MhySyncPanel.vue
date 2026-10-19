<script setup lang="ts">
/**
 * 原神 / 星铁的“读取”：从游戏缓存读抽卡链接（找不到目录时手动选择）、等待读取（轮询缓存的修改时间）、粘贴链接，
 * 然后由 syncMhy 同步（src/lib/mhy/sync.ts）。请求全部由本机后端直连米哈游官方接口。
 *
 * 抽卡链接里有 authkey，当凭据处理：粘贴框不回显、不保存，交给后端后马上清空；界面上任何地方都不显示链接内容。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { MHY_GAME_LABEL, MHY_POOLS, type MhyGame } from '@/lib/mhy/types'
import {
  type MhyLinkSource,
  type MhyRpc,
  MhySyncError,
  type MhySyncProgress,
  type MhySyncResult,
  mhyCacheStamp,
  mhyLocate,
  syncMhy,
} from '@/lib/mhy/sync'
import { desktopBridge } from '@/lib/transport'

const props = defineProps<{ game: MhyGame }>()
const emit = defineEmits<{ synced: [accountId: string] }>()
const toast = useToast()

const bridge = desktopBridge()
const rpc: MhyRpc = (method, params) => (bridge ? bridge.rpc(method, params) : Promise.reject({ code: -32000, message: '只有桌面版能读取' }))
const label = computed(() => MHY_GAME_LABEL[props.game])
/** 原神叫“祈愿记录”，星铁叫“跃迁记录” */
const recordName = computed(() => (props.game === 'genshin' ? '祈愿记录' : '跃迁记录'))

// ───── 手动选择的游戏目录（记在本机，不是敏感信息） ─────
const dirKey = computed(() => `arkrecord:mhy:${props.game}:dataDir`)
function readDir(): string | null {
  try {
    return localStorage.getItem(dirKey.value)
  } catch {
    return null
  }
}
const dataDir = ref<string | null>(readDir())
function setDir(value: string | null) {
  dataDir.value = value
  try {
    if (value) localStorage.setItem(dirKey.value, value)
    else localStorage.removeItem(dirKey.value)
  } catch {
    // 存不了也不影响这次使用
  }
}

// ───── 状态 ─────
const running = ref(false)
const progress = ref<MhySyncProgress | null>(null)
interface Problem {
  kind: string
  message: string
  partial?: MhySyncResult
}
const problem = ref<Problem | null>(null)

const cacheSource = (): MhyLinkSource => ({ kind: 'cache', ...(dataDir.value ? { dataDir: dataDir.value } : {}) })

async function run(source: MhyLinkSource) {
  if (running.value) return
  running.value = true
  problem.value = null
  progress.value = { stage: '准备中', fetched: 0 }
  try {
    const result = await syncMhy(rpc, props.game, source, { onProgress: (p) => (progress.value = p) })
    toast.add({
      title: result.added ? `同步完成，新增 ${result.added} 条记录` : '同步完成，没有新记录',
      description: result.account ? `${label.value} · UID ${result.account.uid}` : `${label.value}的这个账号还没有任何${recordName.value}`,
      color: 'success',
      icon: 'i-lucide-circle-check',
    })
    if (result.warnings.length) {
      toast.add({ title: '有些地方需要注意', description: result.warnings.join('；'), color: 'warning', icon: 'i-lucide-triangle-alert', duration: 10_000 })
    }
    if (result.account) emit('synced', result.account.id)
  } catch (error) {
    if (error instanceof MhySyncError) {
      problem.value = { kind: error.kind, message: error.message, partial: error.partial }
      if (error.partial?.account) emit('synced', error.partial.account.id)
    } else {
      problem.value = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    running.value = false
    progress.value = null
  }
}

/** 从游戏缓存读取：没有手动选过目录时先找目录，找不到就提示手动选择 */
async function readFromCache() {
  stopWaiting()
  problem.value = null
  if (!dataDir.value) {
    try {
      const located = await mhyLocate(rpc, props.game)
      if (!located.dataDirs.length) {
        problem.value = { kind: 'game_not_found', message: `没有找到${label.value}的游戏目录。` }
        return
      }
    } catch (error) {
      problem.value = { kind: error instanceof MhySyncError ? error.kind : 'unknown', message: error instanceof Error ? error.message : String(error) }
      return
    }
  }
  await run(cacheSource())
}

async function pickDir() {
  if (!bridge) return
  try {
    const result = (await bridge.rpc('app.pickDirectory', { title: `选择${label.value}的游戏目录` })) as { path?: unknown } | null
    if (typeof result?.path !== 'string') return
    setDir(result.path)
    await run(cacheSource())
  } catch {
    problem.value = { kind: 'unknown', message: '打不开选择目录的窗口' }
  }
}

// ───── 等待读取：在游戏里打开抽卡记录后，缓存的修改时间会变，变了就自动读取 ─────
const WAIT_INTERVAL_MS = 3000
const WAIT_LIMIT_MS = 10 * 60_000
/** 缓存刚变时链接可能还没写完，稍等一下再读 */
const SETTLE_MS = 1500
const waiting = ref(false)
let waitTimer: ReturnType<typeof setTimeout> | undefined

function stopWaiting() {
  waiting.value = false
  clearTimeout(waitTimer)
}

async function startWaiting() {
  if (waiting.value || running.value) return
  problem.value = null
  waiting.value = true
  const deadline = Date.now() + WAIT_LIMIT_MS
  let baseline: number | null
  try {
    baseline = await mhyCacheStamp(rpc, props.game, dataDir.value ?? undefined)
  } catch (error) {
    stopWaiting()
    problem.value = { kind: error instanceof MhySyncError ? error.kind : 'unknown', message: error instanceof Error ? error.message : String(error) }
    return
  }
  const tick = () => {
    waitTimer = setTimeout(async () => {
      if (!waiting.value) return
      if (Date.now() > deadline) {
        stopWaiting()
        problem.value = { kind: 'wait_timeout', message: `等了 10 分钟，没有发现新的${recordName.value}。` }
        return
      }
      const stamp = await mhyCacheStamp(rpc, props.game, dataDir.value ?? undefined).catch(() => undefined)
      if (!waiting.value) return
      if (stamp != null && stamp !== baseline) {
        stopWaiting()
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
        await run(cacheSource())
        return
      }
      tick()
    }, WAIT_INTERVAL_MS)
  }
  tick()
}
onBeforeUnmount(stopWaiting)

// ───── 粘贴链接：不回显、不保存，交给后端后马上清空 ─────
const pasteOpen = ref(false)
const pasteUrl = ref('')
function submitPaste() {
  const url = pasteUrl.value.trim()
  pasteUrl.value = ''
  pasteOpen.value = false
  if (!url) return
  stopWaiting()
  void run({ kind: 'url', url })
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
  if (p.kind === 'game_not_found') return '没有找到游戏目录'
  if (p.kind === 'rate_limited') return '请求太频繁'
  if (p.kind === 'network') return '网络连接失败'
  return '读取失败'
})
const problemHint = computed(() => {
  const p = problem.value
  if (!p) return ''
  if (NEED_OPEN.has(p.kind)) return `在游戏里打开一次${recordName.value}（翻一页就行），再点“读取”；也可以点“等待读取”，打开后会自动读取。链接大约 24 小时后过期。`
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
