import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceSighting, peakMultiple, type Reading, type Sighting } from './sightings'

/** Readings for a 1B-supply token, so market cap = price × 1e9. */
function r(at: number, price: number, liquidity: number, marketCap = price * 1e9): Reading {
  return { at, price, marketCap, liquidity }
}

function fold(readings: Reading[]): Sighting | undefined {
  return readings.reduce<Sighting | undefined>((s, reading) => advanceSighting(s, reading), undefined)
}

test('records the first reading and raises the peak', () => {
  const s = fold([r(100, 0.00005, 20_000), r(200, 0.0004, 60_000), r(300, 0.00015, 40_000)])
  assert.equal(s?.firstSeenAt, 100)
  assert.equal(s?.firstMc, 50_000)
  assert.equal(s?.peakMc, 400_000)
  assert.equal(s?.peakAt, 200)
  assert.equal(peakMultiple(s!.firstPrice, s!.peakPrice), 8)
})

test('accepts a real 100x pump, where liquidity grows far slower than price', () => {
  const s = fold([r(1, 0.00003, 15_000), r(2, 0.003, 150_000)])
  assert.equal(peakMultiple(s!.firstPrice, s!.peakPrice), 100)
})

test('ignores a one-off glitch from a spoofed pool (BOP)', () => {
  const s = fold([r(1, 0.0009248, 96_502), r(2, 0.0004384, 71_607), r(3, 7.24, 1_192_171_715), r(4, 0.0003091, 60_141)])
  assert.equal(s?.peakPrice, 0.0009248)
  assert.equal(s?.lastPrice, 0.0003091)
})

test('keeps ignoring a sustained spoofed price (BI)', () => {
  const s = fold([
    r(1, 0.00003382, 15_498),
    r(2, 0.00001437, 10_175),
    r(3, 0.2198, 161_399_861),
    r(4, 0.5337, 250_957_305),
    r(5, 0.07211, 95_317_258),
  ])
  assert.equal(s?.peakPrice, 0.00003382)
})

test('a flipping market cap at a steady price is not a multiple (bridged ZEC)', () => {
  const s = fold([
    r(1, 307.5, 2_870_000, 35_889),
    r(2, 308.1, 2_900_000, 140_771_522),
    r(3, 306.9, 2_850_000, 31_000),
  ])
  assert.ok(peakMultiple(s!.firstPrice, s!.peakPrice)! < 1.01)
})

test('a reading without a price moves first-seen earlier and nothing else', () => {
  const s = fold([r(500, 0.00008, 20_000), { at: 100, price: 0, marketCap: 0, liquidity: 0 }])
  assert.equal(s?.firstSeenAt, 100)
  assert.equal(s?.firstPrice, 0.00008)
})
