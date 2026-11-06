import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compactUsd, formatAlertMessage, MAX_LISTED, type AlertToken } from './telegram-format'

const token = (symbol: string, extra: Partial<AlertToken> = {}): AlertToken => ({
  contract: `${symbol}contractaddress`,
  symbol,
  name: symbol,
  walletCount: 5,
  marketCap: 480_000,
  priceChange24h: 41.23,
  ...extra,
})

describe('compactUsd', () => {
  it('shortens large amounts', () => {
    assert.equal(compactUsd(480_000), '$480K')
    assert.equal(compactUsd(1_234_567), '$1.2M')
    assert.equal(compactUsd(850), '$850')
    assert.equal(compactUsd(0), '$0')
  })
})

describe('formatAlertMessage', () => {
  it('lists each token with traders, market cap and move, linked to its chart', () => {
    const html = formatAlertMessage('Alert: Small caps', 'solana', [token('PIXL'), token('NOVA', { walletCount: 1, priceChange24h: -3 })])
    assert.match(html, /^🐋 <b>Alert: Small caps<\/b> · Solana\n2 new tokens\n\n/)
    assert.match(html, /<a href="https:\/\/dexscreener.com\/solana\/PIXLcontractaddress"><b>PIXL<\/b><\/a> · 5 top traders · \$480K mcap · \+41\.2% 24h/)
    assert.match(html, /NOVA<\/b><\/a> · 1 top trader · \$480K mcap · -3\.0% 24h/)
  })

  it('escapes names so a token cannot inject markup', () => {
    const html = formatAlertMessage('Alert: <b>x</b>', 'bsc', [token('<script>')])
    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(html.includes('Alert: &lt;b&gt;x&lt;/b&gt;'))
  })

  it('caps the list and counts the rest', () => {
    const tokens = Array.from({ length: MAX_LISTED + 3 }, (_, i) => token(`T${i}`))
    const html = formatAlertMessage('Early signal', 'robinhood', tokens)
    assert.equal((html.match(/<a href=/g) ?? []).length, MAX_LISTED)
    assert.match(html, /…and 3 more$/)
  })
})
