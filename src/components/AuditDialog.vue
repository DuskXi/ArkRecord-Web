<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ATTESTATIONS_URL, AUDIT_WORKFLOW_URL, type LiveDeployment, loadLiveDeployment, MANIFEST_PATH, shortCommit } from '@/lib/audit'
import { BUILD_COMMIT, DESIGN_URL, REPO_URL, SECURITY_URL } from '@/lib/cloud/links'
import { APP_VERSION } from '@/stores/app'

/**
 * 线上代码审计：用普通人能看懂的话说明“网站运行的就是公开源码”是怎么保证的，显示现在运行的版本，给出自己核对的方法和局限。
 * 这里显示的信息来自网站自己，只作参考；核对必须在网页之外完成（被篡改的网页也可以假装核对通过）。
 */
const open = defineModel<boolean>('open', { default: false })
const toast = useToast()

const live = ref<LiveDeployment | null>(null)
const loading = ref(false)
async function load() {
  loading.value = true
  try {
    live.value = await loadLiveDeployment()
  } finally {
    loading.value = false
  }
}
watch(open, (value) => {
  if (value && !live.value && !loading.value) void load()
})

const origin = location.origin
const manifest = computed(() => live.value?.manifest ?? null)
const commit = computed(() => live.value?.commit ?? manifest.value?.commit ?? null)

/** 网页、线上运行的版本、构建清单三者是否一致 */
const status = computed<{ color: 'success' | 'warning' | 'neutral'; label: string; text: string } | null>(() => {
  const l = live.value
  if (!l) return null
  if (!l.manifest) return { color: 'neutral', label: '没有构建清单', text: l.note ?? '' }
  if (l.commit && l.commit !== l.manifest.commit) return { color: 'warning', label: '不一致', text: '正在运行的版本和构建清单不是同一个 commit，可能刚好在部署，过一会儿再看；一直这样请到 GitHub 反馈。' }
  if (BUILD_COMMIT !== 'dev' && l.commit && BUILD_COMMIT !== l.commit) return { color: 'neutral', label: '网站刚更新', text: '你打开的网页是更新之前的版本，刷新页面后再看。' }
  return { color: 'success', label: '一致', text: '你打开的网页、服务器正在运行的版本、构建清单是同一个 commit。' }
})

const runId = computed(() => manifest.value?.runUrl?.match(/runs\/(\d+)/)?.[1] ?? null)

const verifyCommand = computed(() => `git clone ${REPO_URL} && cd ArkRecord-Web\nnode scripts/audit/verify-site.mjs --site ${origin}`)
const rebuildCommand = computed(() => {
  const c = commit.value ?? '<commit>'
  const env = manifest.value?.environment === 'production' ? 'CLOUDFLARE_ENV=production ' : ''
  return `git checkout ${c} && npm ci\nGITHUB_SHA=${c} ${env}npx vite build\nnode scripts/audit/manifest.mjs --compare ${origin}${MANIFEST_PATH}`
})

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: '已复制', color: 'success', icon: 'i-lucide-check', duration: 2000 })
  } catch {
    toast.add({ title: '复制失败，请手动选择复制', color: 'warning', icon: 'i-lucide-copy' })
  }
}

const STEPS = [
  {
    icon: 'i-lucide-code',
    title: '源码公开',
    text: '网站的全部源码都在 GitHub 上，任何人都能阅读，包括在你的浏览器里加密云同步数据的代码。',
    link: { label: '查看源码', to: REPO_URL },
  },
  {
    icon: 'i-lucide-hammer',
    title: '公开构建',
    text: '网站只通过 GitHub Actions 构建和部署，每一步的记录都公开。同一份源码在任何电脑上构建，得到的文件逐字节相同，所以别人可以自己构建来比对。',
    link: null,
  },
  {
    icon: 'i-lucide-stamp',
    title: '构建证明',
    text: '每次部署，GitHub 都会为“这份源码构建出了哪些文件”签发证明（列出每个文件的指纹），记录在 Sigstore 的公开透明日志里。日志只能追加，事后删不掉，也改不了时间，本站运营者也做不到。',
    link: { label: '查看构建证明', to: ATTESTATIONS_URL },
  },
  {
    icon: 'i-lucide-calendar-check',
    title: '每日核对',
    text: '仓库里公开的定时任务每天把线上的网站文件、服务器代码和构建证明对照一遍，每次部署后也立即核对。服务器代码外人拿不到，由它代为取回比对。结果公开在 GitHub，出问题会标成红色。',
    link: { label: '查看核对记录', to: AUDIT_WORKFLOW_URL },
  },
]

const LIMITS = [
  'Cloudflare 没有能从密码学上证明“服务器正在运行哪份代码”的机制。这些措施能让绕过公开流程的部署被发现、留下删不掉的记录，但不能从技术上阻止。',
  '核对每天一次：临时换上别的网页文件、在下一次核对前换回来，可能发现不了。服务器代码不会漏：上传过的每个版本都会被核对到。',
  '只对个别用户返回不同的网页，别人核对时看不出来；在意的话可以自己运行下面的核对脚本。',
  '审计能确认运行的是公开的代码，但公开代码本身允许的事仍然成立，例如无密码模式下服务器能算出解开数据的钥匙。',
]
</script>

<template>
  <UModal v-model:open="open" title="线上代码审计" description="确认这个网站运行的，就是 GitHub 上公开的源码" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div class="space-y-6 text-sm">
        <p class="leading-relaxed text-muted">
          “源码公开”不等于“网站运行的就是这份源码”。所以本站每次部署都会留下任何人都能核对的公开记录，并且每天自动核对一次。不懂技术也没关系，下面说明它是怎么做到的。
        </p>

        <!-- 现在运行的版本 -->
        <section class="rounded-(--ui-radius) border border-default p-4">
          <div class="mb-3 flex items-center gap-2">
            <UIcon name="i-lucide-git-commit-horizontal" class="size-4 text-primary" />
            <h3 class="font-semibold text-highlighted">现在运行的版本</h3>
            <UBadge v-if="status" :label="status.label" :color="status.color" variant="subtle" size="sm" class="ml-auto" />
            <UIcon v-else-if="loading" name="i-lucide-refresh-cw" class="ml-auto size-4 animate-spin text-dimmed" />
          </div>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt class="text-muted">网站版本</dt>
            <dd class="font-display text-highlighted">v{{ APP_VERSION }}</dd>
            <dt class="text-muted">源码</dt>
            <dd>
              <ULink v-if="commit" :to="`${REPO_URL}/tree/${commit}`" target="_blank" class="font-mono text-primary">commit {{ shortCommit(commit) }}</ULink>
              <span v-else class="text-dimmed">{{ loading ? '读取中…' : '未知（本地开发）' }}</span>
            </dd>
            <template v-if="manifest">
              <dt class="text-muted">构建与部署</dt>
              <dd>
                <ULink v-if="manifest.runUrl" :to="manifest.runUrl" target="_blank" class="text-primary">GitHub Actions 运行 #{{ runId }}</ULink>
                <span v-else class="text-dimmed">—</span>
              </dd>
              <dt class="text-muted">构建清单</dt>
              <dd>
                <a :href="MANIFEST_PATH" target="_blank" rel="noopener" class="text-primary">{{ manifest.files }} 个网站文件，以及服务器代码（{{ manifest.modules.join('、') }}）</a>
              </dd>
              <dt class="text-muted">清单指纹</dt>
              <dd class="break-all font-mono text-dimmed">sha256:{{ manifest.digest }}</dd>
            </template>
          </dl>
          <p v-if="status?.text" class="mt-3 text-xs leading-relaxed text-muted">{{ status.text }}</p>
          <p class="mt-2 text-xs leading-relaxed text-dimmed">这些信息来自网站自己，只方便你对照；能不能信，要靠下面这些网站以外的记录。</p>
        </section>

        <!-- 怎么保证的 -->
        <section>
          <h3 class="mb-3 font-semibold text-highlighted">怎么保证的</h3>
          <ol class="space-y-3">
            <li v-for="(s, i) in STEPS" :key="s.title" class="flex gap-3">
              <span class="grid size-8 shrink-0 place-items-center rounded-(--ui-radius) bg-primary/10 text-primary">
                <UIcon :name="s.icon" class="size-4" />
              </span>
              <div class="min-w-0">
                <p class="font-medium text-highlighted">{{ i + 1 }}. {{ s.title }}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ s.text }}</p>
                <ULink v-if="s.link" :to="s.link.to" target="_blank" class="mt-1 inline-flex items-center gap-1 text-xs text-primary">
                  {{ s.link.label }}
                  <UIcon name="i-lucide-external-link" class="size-3" />
                </ULink>
              </div>
            </li>
          </ol>
        </section>

        <!-- 自己核对 -->
        <section class="space-y-3">
          <h3 class="font-semibold text-highlighted">自己核对</h3>
          <p class="text-xs leading-relaxed text-muted">
            <b class="text-highlighted">不需要技术基础：</b>打开 GitHub 上的
            <ULink :to="AUDIT_WORKFLOW_URL" target="_blank" class="text-primary">每日核对记录</ULink>，看最近一次是不是绿色的对勾，点进去能看到核对了哪些内容。
          </p>
          <div class="space-y-2">
            <p class="text-xs leading-relaxed text-muted">
              <b class="text-highlighted">有一点技术基础：</b>在自己的电脑上运行核对脚本（需要 Node 20 以上和已登录的 GitHub CLI）。它会验证构建证明，再逐个下载这个网站的文件比对：
            </p>
            <div class="relative">
              <pre class="overflow-x-auto rounded-(--ui-radius) bg-elevated p-3 pr-10 font-mono text-[11px] leading-relaxed text-highlighted">{{ verifyCommand }}</pre>
              <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" class="absolute top-1.5 right-1.5" aria-label="复制命令" @click="copy(verifyCommand)" />
            </div>
            <p class="text-xs leading-relaxed text-muted">也可以从源码自己构建，再和线上的构建清单比对：</p>
            <div class="relative">
              <pre class="overflow-x-auto rounded-(--ui-radius) bg-elevated p-3 pr-10 font-mono text-[11px] leading-relaxed text-highlighted">{{ rebuildCommand }}</pre>
              <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" class="absolute top-1.5 right-1.5" aria-label="复制命令" @click="copy(rebuildCommand)" />
            </div>
          </div>
        </section>

        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-eye-off"
          title="为什么不在这个页面里直接核对"
          description="如果网站真的被篡改了，这个弹窗本身也可能被改掉，假装显示“一切正常”。所以核对必须用网站以外的东西完成：GitHub 上的记录、公开透明日志，或者在你自己电脑上运行的脚本。"
        />

        <section>
          <h3 class="mb-2 flex items-center gap-1.5 font-semibold text-highlighted">
            <UIcon name="i-lucide-triangle-alert" class="size-4 text-warning" />
            局限
          </h3>
          <ul class="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted marker:text-dimmed">
            <li v-for="l in LIMITS" :key="l">{{ l }}</li>
          </ul>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap gap-x-3 text-xs">
          <ULink :to="`${SECURITY_URL}#对照线上代码`" target="_blank" class="text-muted hover:text-primary">安全说明（完整版）</ULink>
          <ULink :to="DESIGN_URL" target="_blank" class="text-muted hover:text-primary">设计文档</ULink>
        </div>
        <UButton label="知道了" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>
