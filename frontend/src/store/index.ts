import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api/client'
import type {
  DownloaderStatus, Episode, EpisodeStatus, FilterTab, Folder, GlobalStatus,
  Show, SystemMetrics, WorkerStatus,
} from '../api/types'

const WORKER_PLACEHOLDER: WorkerStatus = {
  running: false,
  active_jobs: 0,
  queued_jobs: 0,
  max_jobs: 2,
  configured_max_jobs: 2,
  configured_max_downloads: 2,
  configured_concurrent_fragments: 3,
  configured_bandwidth_limit: 0,
  last_warning: '',
  orphan_count: 0,
  paused: false,
}

const DOWNLOADER_PLACEHOLDER: DownloaderStatus = {
  active: 0,
  orphans: 0,
}

const METRICS_PLACEHOLDER: SystemMetrics = {
  queue_count: 0,
  bandwidth_bps: null,
  public_ip: null,
  uptime_seconds: null,
  active_downloads: 0,
  cdn_waiting: 0,
  max_downloads: 2,
}

interface AppState {
  // ── Data ──────────────────────────────────────────────────────────────────
  shows: Show[]
  episodes: Episode[]
  activeShowId: number | null
  globalStatus: GlobalStatus
  workerStatus: WorkerStatus
  systemMetrics: SystemMetrics
  downloaderStatus: DownloaderStatus
  folders: Folder[]
  selectedShowIds: Set<number>

  // ── UI ────────────────────────────────────────────────────────────────────
  selectedIds: Set<number>
  scanningIds: Set<number>
  episodeMessages: Map<number, string>   // ephemeral SSE activity messages per episode
  filter: FilterTab
  configOpen: boolean

  // ── SSE connections ───────────────────────────────────────────────────────
  sseConnections: Map<number, EventSource>

  // ── Actions: shows ────────────────────────────────────────────────────────
  loadShows: () => Promise<void>
  addShow: (url: string) => Promise<void>
  deleteShow: (showId: number) => Promise<void>
  selectShow: (showId: number) => Promise<void>

  // ── Actions: episodes ─────────────────────────────────────────────────────
  loadEpisodes: (showId: number) => Promise<void>
  downloadEpisodes: (ids: number[], preferredSource?: string) => Promise<void>
  downloadSubsOnly: (id: number) => Promise<void>
  removeEpisodes: (ids: number[], deleteFiles: boolean) => Promise<void>
  cancelEpisode: (id: number) => Promise<void>
  resetEpisode: (id: number, flags?: { deleteFile?: boolean; deleteTemp?: boolean; deleteLog?: boolean }) => Promise<void>
  resumeEpisode: (id: number) => Promise<void>
  rescanEpisodes: (ids: number[]) => Promise<void>
  rediscoverEpisodes: () => Promise<void>

  // ── Actions: UI ───────────────────────────────────────────────────────────
  setFilter: (filter: FilterTab) => void
  toggleSelected: (id: number) => void
  selectAll: (ids: number[]) => void
  clearSelected: () => void
  setConfigOpen: (open: boolean) => void

  // ── Actions: SSE ──────────────────────────────────────────────────────────
  attachSSE: (episodeId: number) => void
  detachSSE: (episodeId: number) => void
  updateEpisodeProgress: (episodeId: number, percent: number, message: string) => void
  clearEpisodeMessage: (episodeId: number) => void

  // ── Actions: worker ───────────────────────────────────────────────────────
  loadWorkerStatus: () => Promise<void>
  setWorkerMaxJobs: (n: number) => Promise<void>
  setWorkerMaxDownloads: (n: number) => Promise<void>
  restartWorker: (mode: 'graceful' | 'immediate') => Promise<void>
  flushQueue: () => Promise<number>
  togglePause: () => Promise<void>

  // ── Actions: system ───────────────────────────────────────────────────────
  loadSystemMetrics: () => Promise<void>
  loadGlobalStatus: () => Promise<void>

  // ── Actions: downloader ───────────────────────────────────────────────────
  loadDownloaderStatus: () => Promise<void>
  stopDownloaders: (mode: 'all' | 'orphans') => Promise<void>

  // ── Actions: folders ──────────────────────────────────────────────────────
  loadFolders: () => Promise<void>
  createFolder: (name: string) => Promise<void>
  deleteFolder: (folderId: number) => Promise<void>

  // ── Actions: show management ──────────────────────────────────────────────
  moveShowToFolder: (showId: number, folderId: number | null) => Promise<void>
  reorderShows: (items: { id: number; sort_order: number }[]) => Promise<void>
  bulkShowAction: (showIds: number[], action: 'archive' | 'remove' | 'queue') => Promise<void>
  toggleSelectedShow: (id: number) => void
  clearSelectedShows: () => void
}

export const useStore = create<AppState>((set, get) => ({
  shows: [],
  episodes: [],
  activeShowId: null,
  globalStatus: { total: 0, done: 0, failed: 0, downloading: 0, queued: 0, pending: 0 },
  workerStatus: WORKER_PLACEHOLDER,
  systemMetrics: METRICS_PLACEHOLDER,
  downloaderStatus: DOWNLOADER_PLACEHOLDER,
  folders: [],
  selectedShowIds: new Set(),
  selectedIds: new Set(),
  scanningIds: new Set(),
  episodeMessages: new Map(),
  filter: 'all',
  configOpen: false,
  sseConnections: new Map(),

  // ── Shows ─────────────────────────────────────────────────────────────────

  loadShows: async () => {
    try {
      const shows = await api.shows.list()
      set({ shows })
    } catch {
      // On failure, retry after 8s — handles brief API restarts after a page refresh
      setTimeout(() => {
        if (get().shows.length === 0) get().loadShows()
      }, 8000)
    }
  },

  addShow: async (url) => {
    await api.shows.add(url)
    const normalised = url.trim().replace(/\/?$/, '/')
    let attempts = 0
    const poll = setInterval(async () => {
      await get().loadShows()
      attempts++
      if (attempts > 40) { clearInterval(poll); return }
      const found = get().shows.find(s => s.url === normalised)
      if (found) {
        clearInterval(poll)
        await get().selectShow(found.id)
      }
    }, 2000)
  },

  deleteShow: async (showId) => {
    await api.shows.delete(showId)
    if (get().activeShowId === showId) {
      set({ activeShowId: null, episodes: [], selectedIds: new Set() })
    }
    await get().loadShows()
  },

  selectShow: async (showId) => {
    // Clear episodes immediately so the old show never flashes under the new show's header
    set({ activeShowId: showId, selectedIds: new Set(), filter: 'all', episodes: [] })
    await get().loadEpisodes(showId)
  },

  // ── Episodes ──────────────────────────────────────────────────────────────

  loadEpisodes: async (showId) => {
    const episodes = await api.shows.episodes(showId)
    // Guard: discard response if the user switched shows while the request was in flight
    if (get().activeShowId !== showId) return
    set({ episodes })
    episodes.forEach(ep => {
      if (ep.status === 'downloading') get().attachSSE(ep.id)
    })
  },

  downloadEpisodes: async (ids, preferredSource) => {
    if (!ids.length) return
    await api.downloads.start(ids, preferredSource)
    ids.forEach(id => get().attachSSE(id))
    setTimeout(() => {
      const { activeShowId } = get()
      if (activeShowId) get().loadEpisodes(activeShowId)
    }, 800)
  },

  cancelEpisode: async (id) => {
    // Optimistic update BEFORE the API call — ensures the stop button clears
    // even if the API call is slow or fails.
    get().detachSSE(id)
    set(state => {
      const newMessages = new Map(state.episodeMessages)
      newMessages.delete(id)
      return {
        episodes: state.episodes.map(ep =>
          ep.id === id ? { ...ep, status: 'cancelling' as EpisodeStatus } : ep
        ),
        episodeMessages: newMessages,
      }
    })
    try {
      await api.episodes.cancel(id)
    } catch {
      // Best-effort — local state is already updated; worker will detect the pending
      // status via cancel_watcher on its next 2s poll and kill the subprocess.
    }
    const { activeShowId } = get()
    if (activeShowId) setTimeout(() => get().loadEpisodes(activeShowId), 1500)
  },

  resetEpisode: async (id, flags = {}) => {
    await api.episodes.reset(id, {
      delete_file: flags.deleteFile ?? false,
      delete_temp: flags.deleteTemp ?? false,
      delete_log:  flags.deleteLog  ?? false,
    })
    const { activeShowId } = get()
    if (activeShowId) setTimeout(() => get().loadEpisodes(activeShowId), 500)
  },

  removeEpisodes: async (ids, deleteFiles) => {
    await api.episodes.remove(ids, deleteFiles)
    get().clearSelected()
    const { activeShowId } = get()
    if (activeShowId) {
      await get().loadEpisodes(activeShowId)
      await get().loadShows()
    }
  },

  downloadSubsOnly: async (id) => {
    await api.episodes.downloadSubs(id)
    get().attachSSE(id)
    // Reload to reflect subtitle_status='pending' immediately
    const { activeShowId } = get()
    if (activeShowId) setTimeout(() => get().loadEpisodes(activeShowId), 300)
  },

  resumeEpisode: async (id) => {
    get().detachSSE(id)
    await api.episodes.reset(id)
    await get().downloadEpisodes([id])
  },

  rescanEpisodes: async (ids) => {
    if (!ids.length) return
    // Snapshot scanned_at so we can detect exactly when each episode's scan completes
    const before = new Map(ids.map(id => {
      const ep = get().episodes.find(e => e.id === id)
      return [id, ep?.scanned_at ?? '']
    }))
    set(state => ({ scanningIds: new Set([...state.scanningIds, ...ids]) }))
    await Promise.all(ids.map(id => api.episodes.scan(id)))
    const deadline = Date.now() + Math.max(120_000, ids.length * 15_000)
    const poll = setInterval(async () => {
      const { activeShowId } = get()
      if (activeShowId) await get().loadEpisodes(activeShowId)
      const stillWaiting = ids.filter(id => {
        const ep = get().episodes.find(e => e.id === id)
        return (ep?.scanned_at ?? '') === before.get(id)
      })
      if (stillWaiting.length === 0 || Date.now() >= deadline) {
        clearInterval(poll)
        set(state => {
          const next = new Set(state.scanningIds)
          ids.forEach(id => next.delete(id))
          return { scanningIds: next }
        })
      }
    }, 3000)
  },

  rediscoverEpisodes: async () => {
    const { activeShowId, shows } = get()
    if (!activeShowId) return
    const show = shows.find(s => s.id === activeShowId)
    if (!show) return
    await api.shows.add(show.url)
  },

  // ── UI ────────────────────────────────────────────────────────────────────

  setFilter: (filter) => set({ filter, selectedIds: new Set() }),
  toggleSelected: (id) => {
    const next = new Set(get().selectedIds)
    next.has(id) ? next.delete(id) : next.add(id)
    set({ selectedIds: next })
  },
  selectAll: (ids) => set({ selectedIds: new Set(ids) }),
  clearSelected: () => set({ selectedIds: new Set() }),
  setConfigOpen: (open) => set({ configOpen: open }),

  // ── SSE ───────────────────────────────────────────────────────────────────

  attachSSE: (episodeId) => {
    const { sseConnections } = get()
    if (sseConnections.has(episodeId)) return
    const es = new EventSource(`/api/episodes/${episodeId}/progress`)
    es.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.snapshot) {
        // Initial state sent by the server on SSE connect — apply actual status directly
        // instead of routing through updateEpisodeProgress which always maps to 'downloading'
        set(state => ({
          episodes: state.episodes.map(ep =>
            ep.id === data.episode_id
              ? { ...ep, status: data.status as EpisodeStatus, progress: data.percent }
              : ep
          ),
        }))
        return
      }
      get().updateEpisodeProgress(data.episode_id, data.percent, data.message)
    }
    es.onerror = () => {
      es.close()
      const next = new Map(get().sseConnections)
      next.delete(episodeId)
      set({ sseConnections: next })
    }
    const next = new Map(sseConnections)
    next.set(episodeId, es)
    set({ sseConnections: next })
  },

  detachSSE: (episodeId) => {
    const { sseConnections } = get()
    sseConnections.get(episodeId)?.close()
    const next = new Map(sseConnections)
    next.delete(episodeId)
    set({ sseConnections: next })
  },

  updateEpisodeProgress: (episodeId, percent, message) => {
    // Subtitle-only job completion sentinel
    if (message === 'subs_done') {
      get().detachSSE(episodeId)
      const { activeShowId } = get()
      if (activeShowId) get().loadEpisodes(activeShowId)
      return
    }

    const isDone = message === 'Complete' || percent >= 100
    set(state => {
      const newMessages = new Map(state.episodeMessages)
      if (isDone || !message) {
        newMessages.delete(episodeId)
      } else {
        newMessages.set(episodeId, message)
      }
      return {
        episodes: state.episodes.map(ep => {
          if (ep.id !== episodeId) return ep
          return { ...ep, progress: percent, status: isDone ? 'done' : 'downloading' }
        }),
        episodeMessages: newMessages,
      }
    })
    if (isDone) {
      get().detachSSE(episodeId)
      get().loadGlobalStatus()
      get().loadShows()
    }
  },

  clearEpisodeMessage: (episodeId) => {
    set(state => {
      const newMessages = new Map(state.episodeMessages)
      newMessages.delete(episodeId)
      return { episodeMessages: newMessages }
    })
  },

  // ── Worker ────────────────────────────────────────────────────────────────

  loadWorkerStatus: async () => {
    try {
      const workerStatus = await api.worker.status()
      set({ workerStatus })
    } catch {
      // Backend not yet implemented — keep placeholder
    }
  },

  setWorkerMaxJobs: async (n) => {
    const clamped = Math.max(1, Math.min(10, n))
    await api.worker.setMaxJobs(clamped).catch(() => {})
    const workerStatus = await api.worker.status().catch(() => null)
    if (workerStatus) set({ workerStatus })
  },

  setWorkerMaxDownloads: async (n) => {
    const clamped = Math.max(1, Math.min(10, n))
    await api.worker.setMaxDownloads(clamped).catch(() => {})
    const workerStatus = await api.worker.status().catch(() => null)
    if (workerStatus) set({ workerStatus })
  },

  restartWorker: async (mode) => {
    await api.worker.restart(mode).catch(() => {})
    const poll = setInterval(async () => {
      const workerStatus = await api.worker.status().catch(() => null)
      if (workerStatus) {
        set({ workerStatus })
        if (workerStatus.max_jobs === workerStatus.configured_max_jobs) clearInterval(poll)
      }
    }, 2000)
    setTimeout(() => clearInterval(poll), 30_000)
  },

  flushQueue: async () => {
    const res = await api.worker.flushQueue()
    const { activeShowId } = get()
    if (activeShowId) await get().loadEpisodes(activeShowId)
    await get().loadWorkerStatus()
    return res.count
  },

  togglePause: async () => {
    await api.worker.togglePause().catch(() => {})
    const workerStatus = await api.worker.status().catch(() => null)
    if (workerStatus) set({ workerStatus })
  },

  // ── System metrics ────────────────────────────────────────────────────────

  loadSystemMetrics: async () => {
    try {
      const systemMetrics = await api.system.metrics()
      set({ systemMetrics })
    } catch {
      // Backend not yet implemented — keep placeholder
    }
  },

  loadGlobalStatus: async () => {
    try {
      const globalStatus = await api.status()
      set({ globalStatus })
    } catch {}
  },

  loadDownloaderStatus: async () => {
    try {
      const downloaderStatus = await api.downloader.status()
      set({ downloaderStatus })
    } catch {}
  },

  stopDownloaders: async (mode) => {
    await api.downloader.stop(mode).catch(() => {})
    setTimeout(() => get().loadDownloaderStatus(), 1500)
  },

  // ── Folders ───────────────────────────────────────────────────────────────

  loadFolders: async () => {
    try {
      const folders = await api.folders.list()
      set({ folders })
    } catch {}
  },

  createFolder: async (name) => {
    await api.folders.create(name)
    await get().loadFolders()
  },

  deleteFolder: async (folderId) => {
    await api.folders.delete(folderId)
    await get().loadFolders()
    await get().loadShows()
  },

  moveShowToFolder: async (showId, folderId) => {
    await api.shows.setFolder(showId, folderId)
    await get().loadShows()
  },

  reorderShows: async (items) => {
    await api.shows.reorder(items)
    await get().loadShows()
  },

  bulkShowAction: async (showIds, action) => {
    await api.shows.bulk(showIds, action)
    set({ selectedShowIds: new Set() })
    await get().loadShows()
    if (action === 'remove') {
      const { activeShowId } = get()
      if (activeShowId && showIds.includes(activeShowId)) {
        set({ activeShowId: null, episodes: [], selectedIds: new Set() })
      }
    }
  },

  toggleSelectedShow: (id) => {
    const next = new Set(get().selectedShowIds)
    next.has(id) ? next.delete(id) : next.add(id)
    set({ selectedShowIds: next })
  },

  clearSelectedShows: () => set({ selectedShowIds: new Set() }),
}))

// Convenience selector for episode counts per filter tab
export function useTabCounts() {
  return useStore(useShallow(state => {
    const eps = state.episodes
    return {
      all:         eps.length,
      not_started: eps.filter(e => e.status === 'pending').length,
      pending:     eps.filter(e => e.status === 'queued' || e.status === 'downloading' || e.status === 'cancelling').length,
      incomplete:  eps.filter(e => e.status === 'cancelled').length,
      done:        eps.filter(e => e.status === 'done').length,
      failed:      eps.filter(e => e.status === 'failed').length,
    }
  }))
}

// Convenience selector for filtered episode ids
export function useFilteredEpisodeIds(filter: FilterTab): number[] {
  return useStore(useShallow(state => {
    const eps = state.episodes
    const filterFn = (ep: { status: EpisodeStatus }) => {
      switch (filter) {
        case 'all':         return true
        case 'not_started': return ep.status === 'pending'
        case 'pending':     return ep.status === 'queued' || ep.status === 'downloading' || ep.status === 'cancelling'
        case 'incomplete':  return ep.status === 'cancelled'
        case 'done':        return ep.status === 'done'
        case 'failed':      return ep.status === 'failed'
      }
    }
    return eps.filter(filterFn).map(e => (e as Episode).id)
  }))
}
