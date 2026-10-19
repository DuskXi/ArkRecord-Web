import { shell } from 'electron'

/** 应用以外的链接（GitHub、鹰角官网、用户协议等）交给系统浏览器，只接受 https */
export function openExternal(value: string): void {
  if (URL.parse(value)?.protocol === 'https:') void shell.openExternal(value)
}
