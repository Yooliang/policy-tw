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
      redirect: '/election/election-2026',
    },
    {
      path: '/candidate/:candidateId',
      component: () => import('../pages/CandidateProfile.vue'),
    },
    {
      path: '/community',
      component: () => import('../pages/Community.vue'),
    },
    {
      path: '/donation',
      component: () => import('../pages/Donation.vue'),
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
