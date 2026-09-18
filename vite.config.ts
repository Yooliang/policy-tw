import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const OUT_DIR = 'dist';

/**
 * SPA 殼（空 #app，只帶 script／css）：
 * - 404.html：Firebase 對未預渲染的路徑回真 404，但仍啟動 app 在客戶端渲染（建置後才新增的政治人物頁照樣能看）。
 * - app.html：工具頁（/verify /contributions /tasks /stats /profile /auth/callback /admin/**）由 firebase.json rewrite 過來，回 200。
 * 兩者都加 noindex；正式內容頁不會用到殼。
 */
const SPA_SHELL_FILES = ['404.html', 'app.html'];
let shellWritten = false;

function writeSpaShell(indexHTML: string): void {
  if (shellWritten) return;
  shellWritten = true;
  const shell = indexHTML.replace('</head>', '    <meta name="robots" content="noindex">\n  </head>');
  for (const file of SPA_SHELL_FILES) {
    fs.writeFileSync(path.resolve(__dirname, OUT_DIR, file), shell, 'utf8');
  }
}

/** vite preview：/politician/123 → dist/politician/123/index.html（sirv 只認 .html 或尾斜線），對齊 Firebase cleanUrls 行為。 */
function previewNestedIndex(): Plugin {
  return {
    name: 'preview-nested-index',
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url && !url.endsWith('/') && !path.extname(url) && fs.existsSync(path.join(__dirname, OUT_DIR, url, 'index.html'))) {
          req.url = `${url}/index.html`;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode, isPreview }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // vite preview 對無副檔名路徑預設一律退回 index.html（首頁），會把 /politician/:id 也當首頁；
      // 預覽時改 mpa 讓它找 <路徑>/index.html。dev server 維持 spa 讓 client-side routing 重新整理不 404。
      appType: isPreview ? 'mpa' : 'spa',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [vue(), previewNestedIndex()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        // SSG_DEBUG_HYDRATION=1 的驗證用 build 會在 console 印出 hydration mismatch 細節（正式 build 關閉）
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: JSON.stringify(process.env.SSG_DEBUG_HYDRATION === '1'),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        outDir: OUT_DIR,
      },
      ssgOptions: {
        // /politician/123 → dist/politician/123/index.html，配 firebase cleanUrls 兩種寫法都能命中
        dirStyle: 'nested',
        // 資料層是模組級全域狀態，一次只能渲染一頁；並行會讓各頁的資料切片互相覆蓋
        concurrency: 1,
        formatting: 'none',
        beastiesOptions: false,
        onBeforePageRender(_route, indexHTML) {
          writeSpaShell(indexHTML);
          return undefined;
        },
      },
    };
});
