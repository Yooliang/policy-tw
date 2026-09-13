/**
 * Hero 動作區的按鈕尺寸，唯一一份。
 *
 * 2026-09-13 小良哥：「其他頁面沒有跟著變小，反而變得有點奇怪。麻煩幫我把其他頁面
 * 動作區的按鈕也調整一下，變成一樣的大小和間距。」
 *
 * 起因是政見那三個頁籤為了在 400px 寬的手機上擠成一排，先單獨縮了一級（compact），
 * 結果同一個網站的動作區出現兩種尺寸。現在只有一種：手機上小一級、桌機維持原樣。
 *
 * 有些按鈕有自己的狀態色（送出中／已排入／失敗），不能整顆換成 HeroAction，
 * 所以尺寸與形狀抽成常數讓它們共用——各頁不要再手打 px-4 py-2.5。
 * 這個檔放在 lib/ 是因為 tailwind.config.js 的 content 有掃 lib 底下的 ts 檔，
 * class 字串要被掃到才會產生對應的 CSS。
 */

/** 圓角、字重、排版：所有動作區按鈕共用 */
export const HERO_ACTION_BASE = 'rounded-xl font-bold flex items-center transition-all whitespace-nowrap'

/** 尺寸與圖示間距。手機縮一級，sm 以上回到原本大小。 */
export const HERO_ACTION_SIZE = 'px-2.5 py-2 text-xs gap-1.5 sm:px-4 sm:py-2.5 sm:text-sm sm:gap-2'

/**
 * 目前所在的頁籤／已選取。
 * border-transparent 是必要的：一般狀態有 1px 邊框，選取狀態沒有的話會矮 2px，
 * 同一排裡選取中的那顆看起來就是塌下去一點。
 */
export const HERO_ACTION_ACTIVE = 'bg-white text-navy-900 shadow-lg border border-transparent'

/** 一般狀態 */
export const HERO_ACTION_IDLE = 'bg-white/10 text-white hover:bg-white/20 border border-white/20'

/**
 * 動作區的圓形圖示按鈕（返回）。高度要跟上面的藥丸對齊，
 * 不然手機上會出現一顆 40px 的圓圈站在 32px 的按鈕旁邊。
 */
export const HERO_ICON_BUTTON = 'w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-all border border-white/10 group shrink-0'

/** 圓形按鈕裡的圖示大小（跟著按鈕縮） */
export const HERO_ICON_SIZE = 20
