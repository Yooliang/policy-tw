/**
 * Monetag MultiTag 載入器。
 * 必須在 Vue app 掛載之後呼叫：Monetag 會把 300x250 橫幅 appendChild 到
 * `settings.appendTo` 指定的容器；容器若不存在就會退回「插在 script 後面」，
 * 也就是掉到 footer 下方。容器由 <AdSlot /> 提供，整站只有一個。
 */
export const AD_SLOT_SELECTOR = '#monetag-slot'

const MONETAG_SRC =
  '//quarrelsomebitter.com/btXzV.s-dCGPlp0pYVWVcG/EeVmc9uubZtUwltkWPqT/cY0gMLT/UM2CNkT/Myt/NnzLQ-xLNlTUYG1uN/ws'

let loaded = false

export function loadMonetag(): void {
  if (loaded || typeof document === 'undefined') return
  if (!document.querySelector(AD_SLOT_SELECTOR)) {
    console.warn('[ads] 找不到廣告容器，略過載入 Monetag')
    return
  }
  loaded = true
  const s = document.createElement('script') as HTMLScriptElement & { settings?: Record<string, unknown> }
  s.settings = { appendTo: AD_SLOT_SELECTOR }
  s.src = MONETAG_SRC
  s.async = true
  s.referrerPolicy = 'no-referrer-when-downgrade'
  document.body.appendChild(s)
}
