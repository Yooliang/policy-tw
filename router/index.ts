import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('../pages/Home.vue'),
    },
    {
      path: '/tracking',
      component: () => import('../pages/PolicyTracking.vue'),
    },
    {
      path: '/policy/:policyId',
      component: () => import('../pages/PolicyDetail.vue'),
    },
{
      path: '/analysis',
      component: () => import('../pages/PolicyAnalysis.vue'),
    },
    {
      path: '/analysis/:policyId',
      component: () => import('../pages/PolicyDeepAnalysis.vue'),
    },
    {
      path: '/election/:electionId',
      component: () => import('../pages/ElectionPage.vue'),
    },
    {
      path: '/election-2026',
      redirect: '/election/1',
    },
    {
      path: '/politician/:politicianId',
      component: () => import('../pages/PoliticianProfile.vue'),
    },
    {
      path: '/community',
      component: () => import('../pages/Community.vue'),
    },
    {
      path: '/community/:discussionId',
      component: () => import('../pages/DiscussionDetail.vue'),
    },
    {
      path: '/donation',
      component: () => import('../pages/Donation.vue'),
    },
    {
      path: '/regional-data',
      component: () => import('../pages/RegionalData.vue'),
    },
    {
      path: '/admin/dashboard',
      component: () => import('../pages/AdminDashboard.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/admin/scraper',
      component: () => import('../pages/AdminScraper.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/admin/duplicates',
      component: () => import('../pages/AdminDuplicates.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/admin/ai',
      component: () => import('../pages/AdminAI.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/admin/import',
      component: () => import('../pages/AdminImport.vue'),
      meta: { requiresAdmin: true },
    },
    {
      path: '/verify',
      component: () => import('../pages/VerifyContent.vue'),
    },
    {
      path: '/ai-assistant',
      component: () => import('../pages/AIChat.vue'),
    },
    {
      path: '/profile',
      component: () => import('../pages/UserProfile.vue'),
    },
    {
      path: '/auth/callback',
      component: () => import('../pages/AuthCallback.vue'),
    },
    {
      path: '/:pathMatch(.*)*',

      redirect: '/',
    },
  ],
  scrollBehavior() {
    return false
  },
})

router.beforeEach(async (to) => {
  if (to.meta.requiresAdmin) {
    const { isAuthenticated, isAdmin, authReady, initAuth } = useAuth()

    // Wait for auth to initialize
    if (!authReady.value) {
      await initAuth()
    }

    if (!isAuthenticated.value || !isAdmin.value) {
      return '/'
    }
  }
})

export default router
