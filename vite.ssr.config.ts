import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 邊緣 SSR 的伺服器端 bundle（docs/PLAN-edge-ssr.md）：
 *   pnpm build:ssr → dist-ssr/entry-server.js，給 cloudflare/ssr-worker.js import。
 * 全部依賴都打進去（noExternal），目標是 Worker（webworker），supabase-js 走 fetch 版。
 * 客戶端 bundle 仍由 `vite-ssg build`（main.ts）產出到 dist/，兩邊各自建置。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [vue()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY ?? ''),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY ?? ''),
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        // 圖表只在瀏覽器渲染；伺服器端給替身（見 lib/ssr/stub-apexcharts.ts）
        'vue3-apexcharts': path.resolve(__dirname, 'lib/ssr/stub-apexcharts.ts'),
        'apexcharts': path.resolve(__dirname, 'lib/ssr/stub-apexcharts.ts'),
      },
      conditions: ['worker', 'browser', 'import', 'module', 'default'],
    },
    ssr: {
      noExternal: true,
      target: 'webworker',
    },
    build: {
      ssr: 'entry-server.ts',
      outDir: 'dist-ssr',
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      rollupOptions: {
        // 動態 import（apexcharts 這類只在瀏覽器用的圖表）要留成獨立 chunk 延遲載入，不能 inline：inline 會在模組載入時就執行、撞 window
        output: { format: 'es', entryFileNames: 'entry-server.js', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
  };
});
