// /skill 頁下方「各型別的做法與交件欄位」：把 public/skill-types.md 依 `<!-- spec … -->` 標記切段，
// 每段配一個標題，頁面用 <details> 收折（預設收起，2026-10-13 小良）。檔頭（維護者附錄）不顯示。
// 切段規則與 supabase/functions/_shared/type-spec.ts 的 parseTypeSpec 相同（標記一行一個、標記前的檔頭不算）。

export interface SkillTypeSection {
  /** 標題（行內 markdown） */
  title: string
  /** 內文（markdown，已拿掉當標題用的那一行） */
  body: string
}

const MARKER_RE = /^<!--\s*spec\s+(.+?)\s*-->\s*$/

function keysLabel(marker: string): string {
  const parts: string[] = []
  for (const part of marker.split('|')) {
    const [k, v = ''] = part.split(':')
    const names = v.split(',').map((s) => s.trim()).filter(Boolean)
    if (names.length === 0) continue
    const kind = k.trim() === 'task' ? '任務' : '交件'
    parts.push(`${kind} ${names.map((n) => '`' + n + '`').join('、')}`)
  }
  return parts.join('；')
}

function titleOf(marker: string, text: string): SkillTypeSection {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const heading = /^#{1,6}\s+(.+)$/.exec(first)
  if (heading) return { title: heading[1].trim(), body: lines.slice(1).join('\n').trim() }
  // 「**`politician`** — 新增人物或補欄位：…」→ `politician` — 新增人物或補欄位
  const typed = /^\*\*(`[a-z_]+`)\*\*(?:（[^）]*）)?\s*—\s*(?:\*\*)?([^：*（。]{1,40})/.exec(first)
  if (typed) return { title: `${typed[1]} — ${typed[2].trim().replace(/[，、,]$/, '')}`, body: text }
  // 「**重複也由你擋**：…」→ 交件 `policy`：重複也由你擋
  const bold = /^\*\*([^*]{1,40})\*\*/.exec(first)
  const label = keysLabel(marker)
  if (bold) return { title: `${label}：${bold[1].replace(/[：:]$/, '')}`, body: text }
  return { title: label, body: text }
}

export function skillTypeSections(md: string): SkillTypeSection[] {
  const out: SkillTypeSection[] = []
  let marker: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (marker !== null) {
      const text = buf.join('\n').trim()
      if (text) out.push(titleOf(marker, text))
    }
    buf = []
  }
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const m = MARKER_RE.exec(line)
    if (m) {
      flush()
      marker = m[1]
      continue
    }
    if (marker !== null) buf.push(line)
  }
  flush()
  return out
}
