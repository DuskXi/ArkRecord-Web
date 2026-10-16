<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import { computed, ref } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  FeedbackError,
  type FeedbackRef,
  GITHUB_ISSUES_URL,
  listFeedbackRefs,
  MAX_CONTACT_LENGTH,
  MAX_MESSAGE_LENGTH,
  submitFeedback,
} from '@/lib/feedback'
import { formatDateTime } from '@/lib/format'
import { GAME_LABEL } from '@/lib/types'
import { APP_VERSION, useAppStore } from '@/stores/app'

const app = useAppStore()
const toast = useToast()
const { copy } = useClipboard({ legacy: true })

const category = ref<FeedbackCategory>('bug')
const message = ref('')
const contact = ref('')
const submitting = ref(false)
const refs = ref<FeedbackRef[]>(listFeedbackRefs())
/** 刚提交的那一条，突出显示 */
const latest = ref<string | null>(null)

const canSubmit = computed(() => message.value.trim().length >= 4 && message.value.length <= MAX_MESSAGE_LENGTH && !submitting.value)
const categoryLabel = (value: string) => FEEDBACK_CATEGORIES.find((c) => c.value === value)?.label ?? value

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const { ref: saved, saved: stored } = await submitFeedback({
      category: category.value,
      message: message.value,
      contact: contact.value,
      appVersion: APP_VERSION,
      game: app.game,
    })
    refs.value = listFeedbackRefs()
    if (!stored) refs.value = [saved, ...refs.value]
    latest.value = saved.id
    message.value = ''
    contact.value = ''
    toast.add({
      title: `已收到反馈 ${saved.id}`,
      description: stored ? '编号保存在这个浏览器里，请另外记下来。' : '这个浏览器无法保存编号，请马上把编号记下来。',
      color: 'success',
      icon: 'i-lucide-circle-check',
      duration: 10_000,
    })
  } catch (error) {
    toast.add({
      title: '提交失败',
      description: error instanceof FeedbackError ? error.message : String(error),
      color: 'error',
      icon: 'i-lucide-circle-x',
    })
  } finally {
    submitting.value = false
  }
}

async function copyId(id: string) {
  await copy(id)
  toast.add({ title: `已复制 ${id}`, color: 'neutral', icon: 'i-lucide-copy' })
}
</script>

<template>
  <PageShell id="feedback" title="反馈" eyebrow="FEEDBACK" :require-account="false" :sync="false" :scoped="false">
    <div class="mx-auto max-w-3xl space-y-10">
      <section>
        <SectionHeader index="01" eyebrow="RECOMMENDED" title="推荐：在 GitHub 提 Issue" />
        <div class="rounded-(--ui-radius) border border-primary/30 bg-primary/5 p-4 text-sm leading-relaxed text-muted">
          <p>
            问题和建议请优先在 GitHub 提 Issue：可以随时看到处理进度和回复，遇到同样问题的人也能看到。
            提问时附上网站版本（<span class="font-display text-highlighted">v{{ APP_VERSION }}</span>）、用的是哪个游戏、做了什么操作、看到了什么提示，会更快定位。
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton :to="`${GITHUB_ISSUES_URL}/new`" target="_blank" label="提交 Issue" icon="i-lucide-github" />
            <UButton :to="GITHUB_ISSUES_URL" target="_blank" label="看看已有的 Issue" color="neutral" variant="outline" icon="i-lucide-list" />
          </div>
        </div>
      </section>

      <section>
        <SectionHeader index="02" eyebrow="IN-SITE" title="不方便用 GitHub？在这里留言" />
        <div class="space-y-4 rounded-(--ui-radius) border border-default p-4">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-bookmark"
            title="提交后会得到一个反馈编号，只保存在这个浏览器里"
            description="编号不会同步到其他设备，也不在导出文件里；清除浏览器数据或换了设备就找不回来，以后的回复也就看不到了。请自己把编号记下来。"
          />

          <UFormField label="类型">
            <URadioGroup v-model="category" :items="[...FEEDBACK_CATEGORIES]" orientation="horizontal" />
          </UFormField>

          <UFormField label="内容" required :hint="`${message.length} / ${MAX_MESSAGE_LENGTH}`">
            <UTextarea
              v-model="message"
              :rows="6"
              :maxlength="MAX_MESSAGE_LENGTH"
              autoresize
              placeholder="遇到了什么问题，或者希望增加什么功能。问题的话请写上做了什么操作、看到了什么提示。"
              class="w-full"
            />
          </UFormField>

          <UFormField label="联系方式（可选）" description="QQ、邮箱等，只有作者能看到。不需要可以不填。">
            <UInput v-model="contact" :maxlength="MAX_CONTACT_LENGTH" placeholder="可选" class="w-full" />
          </UFormField>

          <ul class="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
            <li>
              会一起附上：网站版本 v{{ APP_VERSION }}、当前游戏（{{ GAME_LABEL[app.game] }}）。不会附上账号、UID、token 或寻访记录，也不记录 IP。
            </li>
            <li><b class="text-highlighted">请不要在内容里填写 token、密码等敏感信息。</b></li>
          </ul>

          <div class="flex justify-end">
            <UButton label="提交反馈" icon="i-lucide-send" :loading="submitting" :disabled="!canSubmit" @click="submit" />
          </div>
        </div>
      </section>

      <section v-if="refs.length">
        <SectionHeader index="03" eyebrow="MY FEEDBACK" title="我提交的反馈" />
        <ul class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <li v-for="r in refs" :key="r.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" :class="r.id === latest ? 'bg-primary/5' : ''">
            <span class="font-mono text-sm font-semibold text-highlighted">{{ r.id }}</span>
            <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" aria-label="复制编号" @click="copyId(r.id)" />
            <UBadge :label="categoryLabel(r.category)" color="neutral" variant="subtle" size="sm" />
            <span class="text-xs text-dimmed">{{ formatDateTime(r.createdAt) }}</span>
            <span class="w-full truncate text-xs text-muted">{{ r.excerpt }}</span>
          </li>
        </ul>
        <p class="mt-2 text-xs text-dimmed">状态：已收到。查看回复的功能还在开发中，届时用这里的编号查看。</p>
      </section>
    </div>
  </PageShell>
</template>
