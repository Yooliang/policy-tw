/** @type {import('tailwindcss').Config} */
// 原本掛在 index.html 的 Tailwind Play CDN inline config 搬到這裡（自訂色一個都不能掉）。
export default {
  content: [
    './index.html',
    './App.vue',
    './main.ts',
    './pages/**/*.vue',
    './components/**/*.vue',
    './composables/**/*.ts',
    './router/**/*.ts',
    './lib/**/*.ts',
  ],
  // PoliticianDropdown 用 `focus:ring-${ringColor}` 動態組 class，掃不到，明列。
  safelist: ['focus:ring-blue-500', 'focus:ring-red-500'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans TC"', 'sans-serif'],
      },
      colors: {
        navy: {
          900: '#0f172a',
          800: '#1e293b',
          700: '#334155',
        },
        primary: {
          DEFAULT: '#2563eb',
          dark: '#1d4ed8',
        },
      },
    },
  },
  plugins: [],
}
