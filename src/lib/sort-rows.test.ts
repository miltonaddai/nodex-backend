import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageRows, sortRows } from './sort-rows'

const rows = [
  { name: 'b', score: 2, volume: 10, launchedAt: '2026-09-02 10:00:00' },
  { name: 'a', score: 5, volume: 1, launchedAt: '2026-09-01 10:00:00' },
  { name: 'c', score: 2, volume: 30, launchedAt: '2026-09-03 10:00:00' },
]

test('sorts numbers in either direction', () => {
  assert.deepEqual(sortRows(rows, [{ key: 'score', order: 'desc' }]).map((r) => r.name), ['a', 'b', 'c'])
  assert.deepEqual(sortRows(rows, [{ key: 'score', order: 'asc' }]).map((r) => r.name), ['b', 'c', 'a'])
})

test('later keys break ties', () => {
  const sorted = sortRows(rows, [
    { key: 'score', order: 'desc' },
    { key: 'volume', order: 'desc' },
  ])
  assert.deepEqual(sorted.map((r) => r.name), ['a', 'c', 'b'])
})

test('sorts strings and timestamps', () => {
  assert.deepEqual(sortRows(rows, [{ key: 'name', order: 'asc' }]).map((r) => r.name), ['a', 'b', 'c'])
  assert.deepEqual(sortRows(rows, [{ key: 'launchedAt', order: 'desc' }]).map((r) => r.name), ['c', 'b', 'a'])
})

test('does not mutate the input', () => {
  const before = rows.map((r) => r.name)
  sortRows(rows, [{ key: 'name', order: 'desc' }])
  assert.deepEqual(rows.map((r) => r.name), before)
})

test('pages and ranks by position', () => {
  const page = pageRows(sortRows(rows, [{ key: 'name', order: 'asc' }]), 1, 1)
  assert.equal(page.length, 1)
  assert.equal(page[0].name, 'b')
  assert.equal(page[0].rank, 2)
})
