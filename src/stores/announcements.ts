import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ANNOUNCEMENTS, popupPlan, readSeen, unreadMajorOf, unreadOf, writeSeen } from '@/lib/announcements'
import { useAppStore } from '@/stores/app'

/** 更新公告：已读记录、未读数、这次要不要弹出（规则见 src/lib/announcements） */
export const useAnnouncementsStore = defineStore('announcements', () => {
  const app = useAppStore()
  const latest = ANNOUNCEMENTS[0]?.id ?? null
  const seen = ref<string | null>(readSeen())
  // 全新访问（这次会显示欢迎窗口）：不弹出更新公告，直接记为已读
  if (seen.value === null && app.welcomeOpen && latest) markAllSeen()

  /** 打开网站时决定好，这次访问内不变（关掉之后 dismissed） */
  const plan = popupPlan(seen.value)
  const dismissed = ref(plan === null)

  const unread = computed(() => unreadOf(seen.value))
  /** 侧边栏的未读数：只算正式更新（小更新只写进公告页） */
  const unreadCount = computed(() => unreadMajorOf(seen.value).length)

  function markAllSeen() {
    if (!latest) return
    writeSeen(latest)
    seen.value = latest
  }

  /** 关掉弹窗、或者打开了公告页：全部算已读 */
  function dismiss() {
    dismissed.value = true
    markAllSeen()
  }

  return { plan, dismissed, seen, unread, unreadCount, markAllSeen, dismiss }
})
