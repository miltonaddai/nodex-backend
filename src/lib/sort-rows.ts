/**
 * In-memory sorting for the ranked tables. Each table is a small worker snapshot (a few hundred
 * rows), so routes cache the whole snapshot once and sort, filter and page it here. Sorting then
 * never needs ClickHouse, which may be idle and take minutes to wake.
 */

export interface SortKey<T> {
  key: keyof T
  order: 'asc' | 'desc'
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''))
}

/** Sorts a copy by the keys in order, later keys breaking ties. */
export function sortRows<T>(rows: readonly T[], keys: SortKey<T>[]): T[] {
  return [...rows].sort((a, b) => {
    for (const { key, order } of keys) {
      const diff = compare(a[key], b[key])
      if (diff !== 0) return order === 'asc' ? diff : -diff
    }
    return 0
  })
}

/** One page of rows, ranked by position in the sorted list. */
export function pageRows<T>(rows: readonly T[], offset: number, pageSize: number): Array<T & { rank: number }> {
  return rows.slice(offset, offset + pageSize).map((row, i) => ({ ...row, rank: offset + i + 1 }))
}
