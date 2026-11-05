import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ApiKeyPool, readKeys } from './api-key-pool'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  mock.restoreAll()
})

/** Replies to each request by the key it carries, and records the keys used. */
function fakeProvider(replies: Record<string, () => Response>) {
  const used: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const key = new URL(String(input)).searchParams.get('key') ?? ''
    used.push(key)
    return (replies[key] ?? (() => new Response('ok')))()
  }) as typeof fetch
  return used
}

const send = (pool: ApiKeyPool) => pool.fetch((key) => ({ url: `https://api.example.com/?key=${key}` }))
const outOfCredits = () => new Response('{"error":{"message":"max usage reached"}}', { status: 429 })
const rateLimited = () => new Response('Too many requests', { status: 429 })

describe('readKeys', () => {
  it('reads the base variable, numbered ones and comma lists, without duplicates', () => {
    const env = { HELIUS_API_KEY: 'a, b', HELIUS_API_KEY_2: 'c', HELIUS_API_KEY_4: 'a', HELIUS_API_KEY_3: '' }
    assert.deepEqual(readKeys('HELIUS_API_KEY', env), ['a', 'b', 'c'])
  })
})

describe('ApiKeyPool', () => {
  it('moves to the next key when one is out of credits', async () => {
    const used = fakeProvider({ a: outOfCredits })
    const pool = new ApiKeyPool('test', ['a', 'b'])
    mock.method(console, 'warn', () => {})
    const res = await send(pool)
    assert.equal(await res.text(), 'ok')
    assert.deepEqual(used, ['a', 'b'])
    await send(pool)
    assert.deepEqual(used, ['a', 'b', 'b'], 'the spent key rests')
  })

  it('stays on the same key for an ordinary rate limit', async () => {
    const used = fakeProvider({ a: rateLimited })
    const res = await send(new ApiKeyPool('test', ['a', 'b']))
    assert.equal(res.status, 429)
    assert.deepEqual(used, ['a'])
  })

  it('treats a rejected key as spent', async () => {
    const used = fakeProvider({ a: () => new Response('unauthorized', { status: 401 }) })
    mock.method(console, 'warn', () => {})
    await send(new ApiKeyPool('test', ['a', 'b']))
    assert.deepEqual(used, ['a', 'b'])
  })

  it('returns the last response when every key is spent', async () => {
    const used = fakeProvider({ a: outOfCredits, b: outOfCredits })
    mock.method(console, 'warn', () => {})
    const res = await send(new ApiKeyPool('test', ['a', 'b']))
    assert.equal(res.status, 429)
    assert.deepEqual(used, ['a', 'b'])
  })

  it('goes back to the first key once its rest is over', async () => {
    const used = fakeProvider({})
    const pool = new ApiKeyPool('test', ['a', 'b'])
    let now = 1_000_000
    mock.method(Date, 'now', () => now)
    mock.method(console, 'warn', () => {})
    fakeProvider({ a: outOfCredits })
    await send(pool)
    now += 61 * 60 * 1000
    const later = fakeProvider({})
    await send(pool)
    assert.deepEqual(later, ['a'])
    assert.deepEqual(used, [])
  })
})
