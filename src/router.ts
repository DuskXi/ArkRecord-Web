import { createRouter, createWebHistory } from 'vue-router'
import { EXTRA_ROUTES } from '@/platform'

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'overview', component: () => import('./pages/OverviewPage.vue') },
    { path: '/history', name: 'history', component: () => import('./pages/HistoryPage.vue') },
    { path: '/banners', name: 'banners', component: () => import('./pages/BannersPage.vue') },
    { path: '/analysis', name: 'analysis', component: () => import('./pages/AnalysisPage.vue') },
    { path: '/stats', name: 'stats', component: () => import('./pages/StatsPage.vue') },
    { path: '/timeline', name: 'timeline', component: () => import('./pages/TimelinePage.vue') },
    { path: '/codex', name: 'codex', component: () => import('./pages/CodexPage.vue') },
    { path: '/ledger', name: 'ledger', component: () => import('./pages/LedgerPage.vue') },
    { path: '/data', name: 'data', component: () => import('./pages/DataPage.vue') },
    { path: '/announcements', name: 'announcements', component: () => import('./pages/AnnouncementsPage.vue') },
    { path: '/feedback', name: 'feedback', component: () => import('./pages/FeedbackPage.vue') },
    { path: '/about', name: 'about', component: () => import('./pages/AboutPage.vue') },
    // 只有桌面版才有的页面（原神等，见 src/platform/index.ts）；网页版这里是空的
    ...EXTRA_ROUTES,
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
