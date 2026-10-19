// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { provideRecords, type RecordsSource, useRecords } from './useRecords'

describe('useRecords', () => {
  it('页面提供了记录来源时，子组件拿到的是它，不去建鹰角的记录仓库', () => {
    // 没有安装 Pinia：要是去建记录仓库会直接报错
    const source = reactive({ accountId: 'mhy:test', events: [] }) as unknown as RecordsSource
    let seen: RecordsSource | undefined
    const Child = defineComponent({
      setup() {
        seen = useRecords()
        return () => h('div')
      },
    })
    const Page = defineComponent({
      setup() {
        provideRecords(source)
        return () => h(Child)
      },
    })
    mount(Page)
    expect(seen).toBe(source)
  })
})
