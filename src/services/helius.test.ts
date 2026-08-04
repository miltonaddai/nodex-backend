import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizedSwapIdentity, normalizeTokenSwaps } from './helius'

test('normalizes a SOL-funded token buy', () => {
  const swaps = normalizeTokenSwaps(
    {
      signature: 'sig',
      timestamp: 1_600,
      type: 'SWAP',
      feePayer: 'wallet',
      tokenTransfers: [
        {
          mint: 'mint',
          fromUserAccount: 'pool',
          toUserAccount: 'wallet',
          tokenAmount: 1_000,
        },
      ],
      nativeTransfers: [
        {
          fromUserAccount: 'wallet',
          toUserAccount: 'pool',
          amount: 2_000_000_000,
        },
      ],
    },
    'mint',
    1_000,
    150
  )

  assert.equal(swaps.length, 1)
  assert.equal(swaps[0].side, 'buy')
  assert.equal(swaps[0].quoteAmount, 2)
  assert.equal(swaps[0].quoteUsd, 300)
  assert.equal(swaps[0].minutesAfterLaunch, 10)
  assert.equal(normalizedSwapIdentity(swaps[0]), 'sig:0')
})

test('ignores unrelated transfers and non-swap transactions', () => {
  assert.deepEqual(
    normalizeTokenSwaps(
      {
        signature: 'sig',
        timestamp: 1_600,
        type: 'TRANSFER',
        feePayer: 'wallet',
        tokenTransfers: [
          { mint: 'mint', fromUserAccount: 'pool', toUserAccount: 'wallet', tokenAmount: 10 },
        ],
      },
      'mint',
      1_000,
      150
    ),
    []
  )
})
