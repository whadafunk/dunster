import type { ActiveDownload, ActiveEpisode, DownloadSettings, DownloaderStatus, Episode, Folder, GlobalStatus, LogSettings, Show, SubtitleSettings, SystemMetrics, WorkerStatus } from './types'

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
    setFolder: (showId: number, folderId: number | null) =>
      fetch(`/api/shows/${showId}/folder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folderId }),
      }).then(r => r.json()),
    reorder: (items: { id: number; sort_order: number }[]) =>
      post<{ status: string }>('/api/shows/reorder', { items }),
    bulk: (showIds: number[], action: 'archive' | 'remove' | 'queue') =>
      post<{ status: string }>('/api/shows/bulk', { show_ids: showIds, action }),
  },
  episodes: {
    active: () => get<ActiveEpisode[]>('/api/episodes/active'),
    scan: (episodeId: number) => post<{ status: string }>(`/api/episodes/${episodeId}/scan`),
    downloadSubs: (episodeId: number) => post<{ status: string }>(`/api/episodes/${episodeId}/download-subs`),
    cancel: (episodeId: number) => post<{ status: string }>(`/api/episodes/${episodeId}/cancel`),
    remove: (episodeIds: number[], deleteFiles: boolean) =>
      post<{ status: string; count: number }>('/api/episodes/remove', { episode_ids: episodeIds, delete_files: deleteFiles }),
    reset: (episodeId: number, flags: { delete_file?: boolean; delete_temp?: boolean; delete_log?: boolean } = {}) =>
      post<{ status: string }>(`/api/episodes/${episodeId}/reset`, flags),
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
    setMaxDownloads: (n: number) => post<{ status: string }>('/api/worker/max-downloads', { max_downloads: n }),
    setConcurrentFragments: (n: number) => post<{ status: string }>('/api/worker/concurrent-fragments', { concurrent_fragments: n }),
    restart: (mode: 'graceful' | 'immediate') =>
      post<{ status: string }>('/api/worker/restart', { mode }),
    activeDownloads: () => get<ActiveDownload[]>('/api/worker/active-downloads'),
    setBandwidth: (mbps: number) =>
      post<{ status: string }>('/api/worker/bandwidth', { bandwidth_limit: mbps }),
    flushQueue: () => post<{ status: string; count: number }>('/api/worker/flush-queue'),
    togglePause: () => post<{ status: string; paused: boolean }>('/api/worker/pause'),
  },

  // ── System metrics ────────────────────────────────────────────────────────
  system: {
    metrics: () => get<SystemMetrics>('/api/system/metrics'),
  },

  // ── Downloader ────────────────────────────────────────────────────────────
  downloader: {
    status: () => get<DownloaderStatus>('/api/downloader/status'),
    stop: (mode: 'all' | 'orphans') => post<{ status: string }>('/api/downloader/stop', { mode }),
  },

  folders: {
    list: () => get<Folder[]>('/api/folders'),
    create: (name: string) => post<Folder>('/api/folders', { name }),
    delete: (folderId: number) => del<{ status: string }>(`/api/folders/${folderId}`),
  },

  // ── Logging settings ──────────────────────────────────────────────────────
  settings: {
    getLogging: () => get<LogSettings>('/api/settings/logging'),
    saveLogging: (s: Partial<LogSettings>) => post<{ status: string }>('/api/settings/logging', s),
    getSubtitles: () => get<SubtitleSettings>('/api/settings/subtitles'),
    saveSubtitles: (s: SubtitleSettings) => post<{ status: string }>('/api/settings/subtitles', s),
    getDownload: () => get<DownloadSettings>('/api/settings/download'),
    saveDownload: (s: Partial<DownloadSettings>) => post<{ status: string }>('/api/settings/download', s),
  },
}
