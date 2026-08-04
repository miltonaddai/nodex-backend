/// <reference types="node" />
import { queryClickhouse } from '../src/services/clickhouse'

async function main() {
  const rows = await queryClickhouse<Record<string, unknown>>(
    `SELECT
       countIf(net0_snipe5 >= 100) AS a_no_floor_snipe5,
       countIf(net10_snipe5 >= 100) AS b_floor10_snipe5,
       countIf(net10_snipe1 >= 100) AS c_floor10_snipe1,
       countIf(net25_snipe1 >= 100) AS d_floor25_snipe1,
       countIf(net0_snipe1 >= 100) AS e_no_floor_snipe1,
       max(net0_snipe5) AS max_a, max(net10_snipe5) AS max_b,
       max(net10_snipe1) AS max_c, max(net0_snipe1) AS max_e,
       count() AS contracts
     FROM (
       SELECT contract,
         uniqExactIf(wallet_address, net > 0 AND entry > 5) AS net0_snipe5,
         uniqExactIf(wallet_address, net >= 10 AND entry > 5) AS net10_snipe5,
         uniqExactIf(wallet_address, net >= 10 AND entry > 1) AS net10_snipe1,
         uniqExactIf(wallet_address, net >= 25 AND entry > 1) AS net25_snipe1,
         uniqExactIf(wallet_address, net > 0 AND entry > 1) AS net0_snipe1
       FROM (
         SELECT contract, wallet_address,
           sumIf(quote_usd, side='buy') - sumIf(quote_usd, side='sell') AS net,
           minIf(minutes_after_launch, side='buy') AS entry
         FROM wallet_token_trades WHERE chain='solana'
         GROUP BY contract, wallet_address
       ) GROUP BY contract
     )`
  )
  console.log('OPTIONS', JSON.stringify(rows, null, 1))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
