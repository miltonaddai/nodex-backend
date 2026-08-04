import dotenv from 'dotenv'
dotenv.config()

const key = process.env.BIRDEYE_API_KEY

async function check(sort: string) {
  const r = await fetch(
    `https://public-api.birdeye.so/defi/tokenlist?sort_by=${sort}&sort_type=desc&offset=0&limit=50`,
    { headers: { 'X-API-KEY': key!, 'x-chain': 'solana' } }
  )
  const j = (await r.json()) as { data?: { tokens?: Array<Record<string, unknown>> } }
  const tokens = j?.data?.tokens ?? []
  const pass = tokens.filter((t) => Number(t.liquidity ?? 0) >= 30_000 && Number(t.v24hUSD ?? 0) >= 30_000)
  console.log(`sort=${sort} status=${r.status} fetched=${tokens.length} pass30k=${pass.length}`)
  if (tokens[0]) {
    const t = tokens[0]
    console.log(`  top: ${t.symbol} liq=${t.liquidity} vol=${t.v24hUSD} mc=${t.mc}`)
  }
  if (pass[0]) {
    const t = pass[0]
    console.log(`  first pass: ${t.symbol} liq=${t.liquidity} vol=${t.v24hUSD} mc=${t.mc}`)
  }
}

async function main() {
  await check('mc')
  await new Promise((r) => setTimeout(r, 1600))
  await check('v24hUSD')
}

main()
