<script setup lang="ts">
/**
 * 无密码模式的保护范围（docs/rewrite/cloud-sync.md 8.1）：开通、切换到无密码模式之前必须看到，并勾选确认。
 * 审计链接指向线上部署的那个 commit。
 */
import { DESIGN_URL, HG_VERIFY_URL, SECURITY_URL } from '@/lib/cloud/links'

const ack = defineModel<boolean>({ default: false })

const ROWS: { who: string; ok: boolean; result: string }[] = [
  { who: '只知道你的 UID', ok: true, result: '拿不到任何东西' },
  { who: '只拿到服务器的存储（数据被导出）', ok: true, result: '解不开（缺服务器密钥）' },
  { who: '本站运营者（持有服务器密钥）', ok: false, result: '技术上可以解密，只能依靠公开代码和运营者不作恶' },
  { who: 'Cloudflare', ok: false, result: '技术上可以解密' },
  { who: '拿到你有效鹰角 token 的人（失效之前）', ok: false, result: '能读取你的云端记录' },
]
</script>

<template>
  <div class="space-y-3 rounded-(--ui-radius) border border-warning/40 bg-warning/5 p-3 text-xs">
    <p class="flex items-center gap-1.5 text-sm font-medium text-highlighted">
      <UIcon name="i-lucide-shield-alert" class="size-4 text-warning" />
      无密码模式的保护范围
    </p>
    <p class="leading-relaxed text-muted">
      不用记密码：每次云同步都用鹰角 token 向服务器证明账号是你的，服务器核实后给出解开数据的钥匙。代价是这把钥匙服务器自己也算得出来——鹰角账号里没有只有你知道的东西，由它派生的钥匙服务器一定也能算出。
    </p>
    <table class="w-full border-collapse">
      <tbody>
        <tr v-for="r in ROWS" :key="r.who" class="border-t border-default first:border-t-0">
          <td class="py-1.5 pr-2 align-top">
            <UIcon :name="r.ok ? 'i-lucide-check' : 'i-lucide-x'" class="size-4" :class="r.ok ? 'text-success' : 'text-error'" />
          </td>
          <td class="py-1.5 pr-2 align-top text-highlighted">{{ r.who }}</td>
          <td class="py-1.5 align-top text-muted">{{ r.result }}</td>
        </tr>
      </tbody>
    </table>
    <p class="leading-relaxed text-muted">
      服务器平时只保存密文，钥匙只在核实通过的请求里给出，不保存、不记录。随时可以切回密码模式（会换一把新钥匙）。
    </p>
    <p class="flex flex-wrap gap-x-3 gap-y-1">
      <ULink :to="HG_VERIFY_URL" target="_blank" class="text-primary">审计：线上运行的 hg-verify.ts</ULink>
      <ULink :to="SECURITY_URL" target="_blank" class="text-primary">安全说明</ULink>
      <ULink :to="`${DESIGN_URL}#8-无密码模式鹰角-token-验证不推荐`" target="_blank" class="text-primary">设计文档第 8 节</ULink>
    </p>
    <UCheckbox v-model="ack" label="我了解：本站运营者、Cloudflare，以及拿到我有效鹰角 token 的人，技术上都能读取我的云端记录" />
  </div>
</template>
