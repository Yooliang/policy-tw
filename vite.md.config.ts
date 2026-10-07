import path from 'node:path';
import { defineConfig } from 'vite';

/**
 * Markdown 摘要預產腳本（scripts/build-data-md.ts）的建置：打成一支 Node 能直接跑的 dist-md/build-data-md.js。
 *   pnpm build:md → node dist-md/build-data-md.js --sql-dir …
 * 為什麼要建置而不是直接跑 TypeScript：資料載入與對應（mapPolicy、mapPolitician）在 composables/useSupabase.ts，
 * 前端程式碼都是無副檔名的相對 import，Node 直接跑不了；跟邊緣 SSR 一樣交給 vite 解析，VITE_SUPABASE_* 建置時烤進去。
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  ssr: { noExternal: true },
  build: {
    ssr: 'scripts/build-data-md.ts',
    outDir: 'dist-md',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'build-data-md.js' } },
  },
});
