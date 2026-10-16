import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', name: 'overview', component: () => import('./pages/OverviewPage.vue') }],
})
