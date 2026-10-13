import { assert, assertEquals } from 'jsr:@std/assert@1'
import { skillTypeSections } from './skill-types-sections.ts'

const md = await Deno.readTextFile(new URL('../public/skill-types.md', import.meta.url))

Deno.test('skill-types.md 每一段都切得出來、都有標題，檔頭附錄不顯示', () => {
  const sections = skillTypeSections(md)
  const markers = [...md.matchAll(/^<!--\s*spec\s+.+?-->\s*$/gm)].length
  assertEquals(sections.length, markers)
  for (const s of sections) {
    assert(s.title.length > 0 && s.title.length <= 120, `標題太長或空的：${s.title}`)
    assert(s.body.length > 0, `內文是空的：${s.title}`)
  }
  assert(!sections.some((s) => s.body.includes('目標分數一覽')), '維護者附錄不該出現在頁面段落裡')
})

Deno.test('標題取法：標題行、型別開頭、粗體開頭', () => {
  const s = skillTypeSections([
    '檔頭',
    '<!-- spec task: question -->',
    '### 回答公民提問（`question`）',
    '內文',
    '<!-- spec contribution: politician -->',
    '**`politician`** — 新增人物或補欄位：`name`✅',
    '<!-- spec contribution: policy -->',
    '**重複也由你擋**：說明',
  ].join('\n'))
  assertEquals(s.map((x) => x.title), ['回答公民提問（`question`）', '`politician` — 新增人物或補欄位', '交件 `policy`：重複也由你擋'])
  assertEquals(s[0].body, '內文')
})
