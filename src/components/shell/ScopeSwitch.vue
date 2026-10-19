<script setup lang="ts">
import { useRecords } from '@/composables/useRecords'

/** 终末地的角色池和武器池规则不同，分开查看（默认角色） */
const records = useRecords()
const items = [
  { label: '角色', value: 'char', icon: 'i-lucide-user-round' },
  { label: '武器', value: 'weapon', icon: 'i-lucide-sword' },
]
</script>

<template>
  <UTabs v-model="records.efScope" :items="items" :content="false" size="xs" aria-label="查看角色或武器" />
</template>
