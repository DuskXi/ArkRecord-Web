/** 在浏览器里生成文件并下载（不经过服务器） */
export function downloadFile(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function csvCell(v: unknown): string {
  return `"${String(v ?? '').replaceAll('"', '""')}"`
}

/** 带 BOM 的 CSV，Excel 打开不会乱码 */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}`
}

export const dateStamp = () => new Date().toISOString().slice(0, 10)
