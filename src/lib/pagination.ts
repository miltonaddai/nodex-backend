export interface PaginationParams {
  page: number
  pageSize: number
  offset: number
}

export interface PaginatedResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  lastUpdated: string | null
  nextUpdate?: string | null
  message?: string
}

export function parsePagination(query: Record<string, unknown>, defaultPageSize = 10): PaginationParams {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1)
  const pageSize = Math.min(50, Math.max(1, parseInt(String(query.pageSize ?? String(defaultPageSize)), 10) || defaultPageSize))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export type SortOrder = 'asc' | 'desc'

export function parseSortOrder(value: unknown): SortOrder {
  return String(value).toLowerCase() === 'asc' ? 'asc' : 'desc'
}

export function pickSortColumn<T extends Record<string, string>>(
  value: unknown,
  map: T,
  fallback: keyof T & string
): string {
  const key = String(value ?? fallback)
  return map[key as keyof T] ?? map[fallback]
}

export function parseNumericFilters<TKey extends string>(
  query: Record<string, unknown>,
  keys: readonly TKey[]
): Partial<Record<TKey, number>> {
  const filters: Partial<Record<TKey, number>> = {}
  for (const key of keys) {
    const raw = Array.isArray(query[key]) ? query[key][0] : query[key]
    if (raw === undefined || raw === null || raw === '') continue
    const value = Number(raw)
    if (Number.isFinite(value)) filters[key] = value
  }
  return filters
}
