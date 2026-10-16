// 在页面渲染前确定深浅色和游戏主题，避免首屏闪烁。
;(function () {
  try {
    var root = document.documentElement
    var mode = localStorage.getItem('vueuse-color-scheme') || 'auto'
    var dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
    root.dataset.game = localStorage.getItem('arkrecord:game') === 'endfield' ? 'endfield' : 'arknights'
  } catch {
    // 隐私模式下 localStorage 可能不可用，使用默认主题
  }
})()
