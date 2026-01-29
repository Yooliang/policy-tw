import { createRouter, createWebHistory } from 'vue-router'

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
      path: '/admin/scraper',
      component: () => import('../pages/AdminScraper.vue'),
    },
    {
      path: '/admin/duplicates',
      component: () => import('../pages/AdminDuplicates.vue'),
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

export default router
