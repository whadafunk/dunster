import type { Episode, GlobalStatus, Show, SystemMetrics, WorkerStatus } from './types'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json()
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`)
  return res.json()
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`)
  return res.json()
}

export const api = {
  shows: {
    list: () => get<Show[]>('/api/shows'),
    add: (url: string) => post<{ status: string }>('/api/shows', { url }),
    delete: (showId: number) => del<{ status: string }>(`/api/shows/${showId}`),
    episodes: (showId: number) => get<Episode[]>(`/api/shows/${showId}/episodes`),
  },
  episodes: {
    scan: (episodeId: number) => post<{ status: string }>(`/api/episodes/${episodeId}/scan`),
    cancel: (episodeId: number) => post<{ status: string }>(`/api/episodes/${episodeId}/cancel`),
    reset: (episodeId: number) => post<{ status: string }>(`/api/episodes/${episodeId}/reset`),
  },
  downloads: {
    start: (episodeIds: number[], preferredSource?: string) =>
      post<{ status: string; count: number }>('/api/download', {
        episode_ids: episodeIds,
        ...(preferredSource ? { preferred_source: preferredSource } : {}),
      }),
  },
  status: () => get<GlobalStatus>('/api/status'),

  // ── Worker (not yet implemented on backend) ───────────────────────────────
  worker: {
    status: () => get<WorkerStatus>('/api/worker/status'),
    setMaxJobs: (n: number) => post<{ status: string }>('/api/worker/max-jobs', { max_jobs: n }),
    restart: () => post<{ status: string }>('/api/worker/restart'),
  },

  // ── System metrics (not yet implemented on backend) ───────────────────────
  system: {
    metrics: () => get<SystemMetrics>('/api/system/metrics'),
  },
}
