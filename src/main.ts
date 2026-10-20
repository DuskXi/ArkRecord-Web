import './assets/css/main.css'

import ui from '@nuxt/ui/vue-plugin'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { initCloudSecrets } from './lib/cloud/secrets'
import { db } from './lib/db'
import { initTokenVault } from './lib/token-vault'
import { router } from './router'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ui)
// 桌面版的鹰角 token、云同步的密码和钥匙只存在系统钥匙串里（见 lib/token-vault.ts、lib/cloud/secrets.ts），
// 要在页面读取账号和云同步状态之前准备好；网页版直接挂载
void Promise.allSettled([initTokenVault(db.accounts), initCloudSecrets()]).finally(() => app.mount('#app'))
