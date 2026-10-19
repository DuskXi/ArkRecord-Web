<script setup lang="ts">
import { computed } from 'vue'
import { useRecords } from '@/composables/useRecords'

/** 终末地的角色池和武器池规则不同，分开查看（默认角色）；武器的叫法看游戏档案 */
const records = useRecords()
const items = computed(() => [
  { label: '角色', value: 'char', icon: 'i-lucide-user-round' },
  { label: records.profile.nouns.weapon, value: 'weapon', icon: 'i-lucide-sword' },
])
</script>

<template>
  <UTabs v-model="records.efScope" :items="items" :content="false" size="xs" aria-label="查看角色或武器" />
</template>
