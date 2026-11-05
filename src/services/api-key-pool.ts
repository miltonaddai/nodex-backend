/**
 * Several API keys for one provider, used in order. When a key runs out of credits (or is
 * rejected) the pool moves to the next one and rests the spent key for a while, since credits
 * reset on the provider's schedule. The first key is always preferred once it is usable again.
 *
 * Ordinary rate limiting (a plain 429 "too many requests") is not a reason to switch: callers
 * keep their own backoff for that. Keys are never logged, only their position in the list.
 */

/** How long a spent key rests before it is tried again. */
const REST_MS = 60 * 60 * 1000

/** Body text that marks a spent or over-quota key, as opposed to a short rate limit. */
const OUT_OF_CREDITS = /credit|max usage|usage limit|quota|compute unit|insufficient|upgrade|plan limit|exhausted/i

/** Reads every key for `name`: NAME, NAME_2 … NAME_10, and comma-separated values in any of them. */
export function readKeys(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const names = [name, ...Array.from({ length: 9 }, (_, i) => `${name}_${i + 2}`)]
  const keys = names.flatMap((variable) => (env[variable] ?? '').split(','))
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))]
}

/** True when the response says the key itself is spent or unusable, not just rate limited. */
async function keyIsSpent(res: Response): Promise<{ spent: boolean; detail: string }> {
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    return { spent: true, detail: `HTTP ${res.status}` }
  }
  if (res.status !== 400 && res.status !== 429) return { spent: false, detail: '' }
  const body = await res.clone().text().catch(() => '')
  const spent = OUT_OF_CREDITS.test(body)
  return { spent, detail: `HTTP ${res.status} ${body.slice(0, 120).replace(/\s+/g, ' ')}` }
}

export class ApiKeyPool {
  private readonly restingUntil = new Map<number, number>()

  constructor(
    private readonly provider: string,
    private readonly keys: string[]
  ) {}

  get size(): number {
    return this.keys.length
  }

  /** The first key that is not resting, or null when every key is spent. */
  private available(): number | null {
    const now = Date.now()
    for (let slot = 0; slot < this.keys.length; slot++) {
      if ((this.restingUntil.get(slot) ?? 0) <= now) return slot
    }
    return null
  }

  /** The key that recovers first, used when all of them are spent so the request still goes out. */
  private soonest(): number {
    let best = 0
    for (let slot = 1; slot < this.keys.length; slot++) {
      if ((this.restingUntil.get(slot) ?? 0) < (this.restingUntil.get(best) ?? 0)) best = slot
    }
    return best
  }

  private rest(slot: number, detail: string): void {
    this.restingUntil.set(slot, Date.now() + REST_MS)
    const next = this.available()
    const label = (index: number) => `key ${index + 1} of ${this.keys.length}`
    console.warn(
      `[${this.provider}] ${label(slot)} is out of credits or rejected (${detail}); ` +
        (next === null ? 'no other key left, retrying the soonest in an hour' : `switching to ${label(next)}`)
    )
  }

  /**
   * Sends a request with the current key. If the response shows the key is spent, rests it and
   * repeats the request with the next key. Returns the last response either way, so callers keep
   * handling rate limits and errors as before. `build` is called once per attempt, so per-request
   * objects such as timeout signals are fresh each time.
   */
  async fetch(build: (key: string) => { url: string; init?: RequestInit }): Promise<Response> {
    let res: Response | null = null
    for (let attempt = 0; attempt < Math.max(this.keys.length, 1); attempt++) {
      const slot = this.available() ?? this.soonest()
      const { url, init } = build(this.keys[slot] ?? '')
      res = await fetch(url, init)
      const { spent, detail } = await keyIsSpent(res)
      if (!spent || this.keys.length === 0) return res
      this.rest(slot, detail)
      if (this.available() === null) return res
    }
    return res as Response
  }
}
