import { describe, expect, it } from 'vitest'
import { tabStripSignature } from './tab-strip-signature'

describe('tabStripSignature', () => {
  it('數量相同但文字不同（縣市長→直轄市長）簽章要不同，底線才會重量', () => {
    const a = [{ key: 'mayor', label: '縣市長' }, { key: 'council', label: '議員' }]
    const b = [{ key: 'mayor', label: '直轄市長' }, { key: 'council', label: '議員' }]
    expect(tabStripSignature(a)).not.toBe(tabStripSignature(b))
  })
  it('完全相同則相同', () => {
    const a = [{ key: 'x', label: '甲' }]
    expect(tabStripSignature(a)).toBe(tabStripSignature([{ key: 'x', label: '甲' }]))
  })
})
