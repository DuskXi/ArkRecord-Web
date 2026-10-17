<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import { computed, ref, watchEffect } from 'vue'
import { checkPassword, generatePassword, MIN_LENGTH, SUGGESTED_LENGTH } from '@/lib/cloud/password'

/** 设置云同步密码：输入两次、实时显示规则（docs/rewrite/cloud-sync.md 7.6），也可以生成随机密码 */
const props = defineProps<{ uid?: string; nickName?: string; label?: string }>()
const password = defineModel<string>({ default: '' })
const valid = defineModel<boolean>('valid', { default: false })

const confirm = ref('')
const show = ref(false)
const generated = ref<string | null>(null)
const { copy, copied } = useClipboard({ legacy: true })

const check = computed(() => checkPassword(password.value, { uid: props.uid, nickName: props.nickName }))
const matches = computed(() => password.value.length > 0 && confirm.value === password.value)
watchEffect(() => (valid.value = check.value.ok && matches.value))

const rules = computed(() => {
  const issues = new Set(check.value.issues)
  const typed = password.value.length > 0
  return [
    { ok: typed && !issues.has('too_short') && !issues.has('too_long'), text: `至少 ${MIN_LENGTH} 位` },
    { ok: typed && !issues.has('missing_upper') && !issues.has('missing_lower') && !issues.has('missing_digit'), text: '同时有大写字母、小写字母和数字' },
    { ok: typed && !issues.has('common') && !issues.has('pattern'), text: '不是常见的简单密码（常见单词、连续或重复字符、键盘顺序、年份）' },
    { ok: typed && !issues.has('contains_uid') && !issues.has('contains_name') && !issues.has('edge_space'), text: '不包含 UID、昵称，开头结尾没有空格' },
    { ok: matches.value, text: '两次输入一致' },
  ]
})

function generate() {
  const p = generatePassword()
  password.value = p
  confirm.value = p
  generated.value = p
  show.value = true
}
</script>

<template>
  <div class="space-y-3">
    <UFormField :label="label ?? '云同步密码'" required>
      <div class="flex gap-2">
        <UInput
          v-model="password"
          :type="show ? 'text' : 'password'"
          autocomplete="new-password"
          spellcheck="false"
          class="min-w-0 flex-1 font-mono"
          :ui="{ trailing: 'pe-1' }"
        >
          <template #trailing>
            <UButton
              :icon="show ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              color="neutral"
              variant="link"
              size="sm"
              :aria-label="show ? '隐藏密码' : '显示密码'"
              @click="show = !show"
            />
          </template>
        </UInput>
        <UButton label="生成" icon="i-lucide-dices" color="neutral" variant="outline" @click="generate" />
      </div>
    </UFormField>
    <UFormField label="再输入一次" required>
      <UInput v-model="confirm" :type="show ? 'text' : 'password'" autocomplete="new-password" spellcheck="false" class="w-full font-mono" />
    </UFormField>

    <ul class="space-y-1 text-xs">
      <li v-for="r in rules" :key="r.text" class="flex items-start gap-1.5" :class="r.ok ? 'text-success' : 'text-muted'">
        <UIcon :name="r.ok ? 'i-lucide-circle-check' : 'i-lucide-circle'" class="mt-px size-3.5 shrink-0" />
        <span>{{ r.text }}</span>
      </li>
      <li class="flex items-start gap-1.5" :class="check.suggested ? 'text-success' : 'text-dimmed'">
        <UIcon :name="check.suggested ? 'i-lucide-circle-check' : 'i-lucide-lightbulb'" class="mt-px size-3.5 shrink-0" />
        <span>建议 {{ SUGGESTED_LENGTH }} 位以上，或者点“生成”</span>
      </li>
    </ul>

    <UAlert
      v-if="generated && generated === password"
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="已生成随机密码，请先保存"
      description="复制到密码管理器，或者抄下来。在别的设备上取回数据需要这个密码，忘记了无法找回。"
      :actions="[{ label: copied ? '已复制' : '复制密码', icon: 'i-lucide-copy', color: 'warning', variant: 'outline', onClick: () => copy(generated!) }]"
    />
  </div>
</template>
