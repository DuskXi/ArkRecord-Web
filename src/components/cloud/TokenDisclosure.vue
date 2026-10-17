<script setup lang="ts">
import { HG_VERIFY_URL, SECURITY_URL } from '@/lib/cloud/links'

/** 发送鹰角 token 之前的声明：发什么、发给谁、做什么用、怎么处理。hg：涉及无密码模式 */
defineProps<{ steps?: string[]; hg?: boolean }>()
</script>

<template>
  <div class="space-y-3 rounded-(--ui-radius) border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed">
    <p class="flex items-center gap-1.5 text-sm font-medium text-highlighted">
      <UIcon name="i-lucide-shield-alert" class="size-4 text-warning" />
      将向本站服务器发送鹰角 token
    </p>
    <ol v-if="steps?.length" class="list-decimal space-y-0.5 ps-5 text-default">
      <li v-for="step in steps" :key="step">{{ step }}</li>
    </ol>
    <dl class="grid gap-x-3 gap-y-1.5 text-muted sm:grid-cols-[4.5rem_1fr]">
      <dt class="font-medium text-default">发送什么</dt>
      <dd>用你的鹰角登录换取的授权（OAuth token），和游戏 UID。</dd>
      <dt class="font-medium text-default">发给谁</dt>
      <dd>本站的云同步服务器（Cloudflare Worker）。</dd>
      <dt class="font-medium text-default">做什么用</dt>
      <dd v-if="hg">
        服务器用它查询鹰角的角色绑定列表，确认这个 UID 是你的。<b class="text-warning">无密码模式下，核实通过后服务器会给出解开云端数据的钥匙</b>（服务器自己也算得出这把钥匙）。
      </dd>
      <dd v-else>服务器用它查询鹰角的角色绑定列表，确认这个 UID 是你的。它只能证明所有权，解不开你的云端数据（数据只有你的云同步密码能解开）。</dd>
      <dt class="font-medium text-default">怎么处理</dt>
      <dd>
        只存在于服务器处理这次请求时的内存里，核实完立即丢弃：不写入存储，不写日志，不出现在任何返回结果里。token 放在请求体里，不出现在网址和请求头里。
      </dd>
    </dl>
    <p class="text-muted">不点“确认发送”，就不会发送。</p>
    <p>
      <ULink :to="HG_VERIFY_URL" target="_blank" class="text-primary">查看服务器核实 token 的代码</ULink>
      ·
      <ULink :to="SECURITY_URL" target="_blank" class="text-primary">安全说明</ULink>
    </p>
  </div>
</template>
