import { liveQuery, type Subscription } from 'dexie'
import { onScopeDispose, type ShallowRef, shallowRef, watch, type WatchSource } from 'vue'

/** 订阅 IndexedDB 查询：数据库变化时自动更新（同步、导入后界面立即刷新） */
export function useLiveQuery<T>(query: () => T | Promise<T>, deps: WatchSource[], initial: T): ShallowRef<T> {
  const value = shallowRef(initial) as ShallowRef<T>
  let subscription: Subscription | undefined
  watch(
    deps,
    () => {
      subscription?.unsubscribe()
      subscription = liveQuery(query).subscribe({
        next: (result) => (value.value = result),
        error: (error) => console.error(error),
      })
    },
    { immediate: true },
  )
  onScopeDispose(() => subscription?.unsubscribe())
  return value
}
