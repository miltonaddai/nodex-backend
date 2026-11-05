import { peakMultiple } from '../lib/sightings'
import { queryClickhouse } from './clickhouse'

/** First-seen and peak fields added to every token row the tables list. */
export interface SightingFields {
  /** When WhaleMo first listed the token, ISO. Null until a pipeline run has recorded it. */
  firstSeenAt: string | null
  /** Market cap when first seen. */
  firstSeenMc: number | null
  /** Market cap at the highest price seen since, sampled once per pipeline run. */
  peakMc: number | null
  /** Peak price over first-seen price. At least 1 once known. */
  peakMultiple: number | null
}

interface SightingRow {
  contract: string
  first_seen_at: string
  first_price: number
  first_mc: number
  peak_price: number
  peak_mc: number
}

const EMPTY: SightingFields = { firstSeenAt: null, firstSeenMc: null, peakMc: null, peakMultiple: null }

/**
 * Sightings for one chain, keyed by contract. Called inside the routes' cached snapshot loaders,
 * so it adds one ClickHouse query per snapshot, not per request. Returns an empty map if the
 * worker has not created the table yet.
 */
async function loadSightings(chain: string): Promise<Map<string, SightingFields>> {
  try {
    const rows = await queryClickhouse<SightingRow>(
      `SELECT contract, first_seen_at, first_price, first_mc, peak_price, peak_mc
       FROM token_sightings FINAL WHERE chain = {chain:String}`,
      { chain }
    )
    return new Map(
      rows.map((row) => {
        const firstMc = Number(row.first_mc)
        const peakMc = Number(row.peak_mc)
        return [
          row.contract,
          {
            firstSeenAt: `${row.first_seen_at.replace(' ', 'T')}Z`,
            firstSeenMc: firstMc > 0 ? firstMc : null,
            peakMc: peakMc > 0 ? peakMc : null,
            peakMultiple: peakMultiple(Number(row.first_price), Number(row.peak_price)),
          },
        ]
      })
    )
  } catch (error) {
    console.warn('Token sightings unavailable:', error instanceof Error ? error.message : error)
    return new Map()
  }
}

/** Adds first-seen and peak multiple fields to each row. */
export async function withSightings<T extends { contract: string }>(
  chain: string,
  rows: T[]
): Promise<Array<T & SightingFields>> {
  const sightings = await loadSightings(chain)
  return rows.map((row) => ({ ...row, ...(sightings.get(row.contract) ?? EMPTY) }))
}
