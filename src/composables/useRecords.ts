/**
 * 统计页面和组件用的“当前记录来源”：默认是鹰角的记录仓库（stores/records.ts）。
 * 别的页面（桌面版的米哈游页面）用 provideRecords 换成自己的来源，下面的组件不用改。
 * 来源的形状和记录仓库对外的字段一致；没有的东西给空值（比如没有截图识别的干员时 roster 是空数组）。
 * 组件里因游戏而不同的地方读 profile（游戏档案，见 lib/game-profile.ts）；game 只留给鹰角专用的地方
 * （图鉴的干员列表、森空岛截图、头像），别的来源填自己的游戏 id。
 */
import { type Component, inject, type InjectionKey, provide } from 'vue'
import { useRecordsStore } from '@/stores/records'

type RecordsStore = ReturnType<typeof useRecordsStore>

export type RecordsSource = Omit<
  Pick<RecordsStore, 'accountId' | 'game' | 'profile' | 'efScope' | 'weaponScope' | 'events' | 'gifts' | 'roster' | 'model' | 'analysis' | 'guarantees' | 'insights' | 'efPools'>,
  'game'
> & { readonly game: string }

/** 提供了别的记录来源的页面怎么显示外壳（PageShell）和账号 */
export interface RecordsHost {
  /** 页面右上角的操作按钮（米哈游是“读取”）。鹰角的同步、云同步按钮和演示数据提示只在鹰角的页面上显示 */
  readonly actions?: Component
  /** 总览、分享图上显示的名字（鹰角页面是游戏昵称） */
  readonly playerName: string
  /** 页面路径的前缀（米哈游是 /genshin、/starrail）：页面之间的链接加上它，鹰角页面是空 */
  readonly base: string
  /** 按名称取头像（米哈游：BWIKI 的图）；没有时 CharAvatar 显示文字。鹰角页面不用，按 game 取 */
  readonly avatar?: (name: string, itemId: string | null) => string | undefined
  /** 分享图底部的图片版权说明 */
  readonly imageCredit?: string
}

const RECORDS_KEY: InjectionKey<RecordsSource> = Symbol('records')
const HOST_KEY: InjectionKey<RecordsHost> = Symbol('records-host')

/** 在页面里提供记录来源，这个页面里的统计组件都从它取数据 */
export function provideRecords(source: RecordsSource, host: RecordsHost = { playerName: '', base: '' }): void {
  provide(RECORDS_KEY, source)
  provide(HOST_KEY, host)
}

/** 当前记录来源：有页面提供的就用它，没有就是鹰角的记录仓库 */
export function useRecords(): RecordsSource {
  return inject(RECORDS_KEY, () => useRecordsStore(), true)
}

/** 提供记录来源的页面的设置；鹰角的页面（没有提供来源）是 null */
export function useRecordsHost(): RecordsHost | null {
  return inject(HOST_KEY, null)
}
