/**
 * 统计页面和组件用的“当前记录来源”：默认是鹰角的记录仓库（stores/records.ts）。
 * 别的页面（桌面版的米哈游页面）用 provideRecords 换成自己的来源，下面的组件不用改。
 * 来源的形状和记录仓库对外的字段一致；没有的东西给空值（比如没有截图识别的干员时 roster 是空数组）。
 */
import { inject, type InjectionKey, provide } from 'vue'
import { useRecordsStore } from '@/stores/records'

export type RecordsSource = Pick<
  ReturnType<typeof useRecordsStore>,
  'accountId' | 'game' | 'efScope' | 'weaponScope' | 'events' | 'gifts' | 'roster' | 'model' | 'analysis' | 'guarantees' | 'insights' | 'efPools'
>

const RECORDS_KEY: InjectionKey<RecordsSource> = Symbol('records')

/** 在页面里提供记录来源，这个页面里的统计组件都从它取数据 */
export function provideRecords(source: RecordsSource): void {
  provide(RECORDS_KEY, source)
}

/** 当前记录来源：有页面提供的就用它，没有就是鹰角的记录仓库 */
export function useRecords(): RecordsSource {
  return inject(RECORDS_KEY, () => useRecordsStore(), true)
}
