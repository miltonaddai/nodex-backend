/// <reference types="node" />
import { readFileSync } from 'fs'

/** Prints the probe output as a compact table for manual inspection. */
function main() {
  const log = readFileSync(process.argv[2] ?? '/tmp/raw.log', 'utf8')
  const rows = JSON.parse(log.slice(log.indexOf('TOKENS ') + 'TOKENS '.length))
  for (const r of rows) {
    console.log(
      [
        r.symbol,
        r.name,
        r.age,
        `holders=${r.holders}`,
        `wallets24h=${r.wallets24h}`,
        `fdv=${Math.round(r.fdv / 1000)}k`,
        `liq=${Math.round(r.liquidity / 1000)}k`,
        `vol=${Math.round(r.vol24h / 1000)}k`,
        `trades=${r.trades24h}`,
        `b/s=${r.buys24h}/${r.sells24h}`,
        `chg=${r.price_change_24h}%`,
        r.address,
      ].join('  ')
    )
  }
}

main()
