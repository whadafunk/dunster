import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../api/client'
import type {
  Episode, EpisodeStatus, FilterTab, GlobalStatus,
  Show, SystemMetrics, WorkerStatus,
} from '../api/types'

// Placeholder worker/metrics until backend is implemented
const WORKER_PLACEHOLDER: WorkerStatus = {
  running: true,
  active_jobs: 0,
  queued_jobs: 0,
  max_jobs: 2,
}

const METRICS_PLACEHOLDER: SystemMetrics = {
  queue_count: 0,
  bandwidth_bps: null,
  public_ip: null,
  uptime_seconds: null,
}

interface AppState {
  // ── Data ──────────────────────────────────────────────────────────────────
  shows: Show[]
  episodes: Episode[]
  activeShowId: number | null
  globalStatus: GlobalStatus
  workerStatus: WorkerStatus
  systemMetrics: SystemMetrics

  // ── UI ────────────────────────────────────────────────────────────────────
  selectedIds: Set<number>
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
  cancelEpisode: (id: number) => Promise<void>
  resetEpisode: (id: number) => Promise<void>
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

  // ── Actions: worker ───────────────────────────────────────────────────────
  loadWorkerStatus: () => Promise<void>
  setWorkerMaxJobs: (n: number) => Promise<void>
  restartWorker: () => Promise<void>

  // ── Actions: system ───────────────────────────────────────────────────────
  loadSystemMetrics: () => Promise<void>
  loadGlobalStatus: () => Promise<void>
}

export const useStore = create<AppState>((set, get) => ({
  shows: [],
  episodes: [],
  activeShowId: null,
  globalStatus: { total: 0, done: 0, failed: 0, downloading: 0, queued: 0, pending: 0 },
  workerStatus: WORKER_PLACEHOLDER,
  systemMetrics: METRICS_PLACEHOLDER,
  selectedIds: new Set(),
  filter: 'all',
  configOpen: false,
  sseConnections: new Map(),

  // ── Shows ─────────────────────────────────────────────────────────────────

  loadShows: async () => {
    const shows = await api.shows.list()
    set({ shows })
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
    set({ activeShowId: showId, selectedIds: new Set(), filter: 'all' })
    await get().loadEpisodes(showId)
  },

  // ── Episodes ──────────────────────────────────────────────────────────────

  loadEpisodes: async (showId) => {
    const episodes = await api.shows.episodes(showId)
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
    await api.episodes.cancel(id)
    get().detachSSE(id)
    const { activeShowId } = get()
    if (activeShowId) setTimeout(() => get().loadEpisodes(activeShowId), 500)
  },

  resetEpisode: async (id) => {
    await api.episodes.reset(id)
    const { activeShowId } = get()
    if (activeShowId) setTimeout(() => get().loadEpisodes(activeShowId), 500)
  },

  rescanEpisodes: async (ids) => {
    await Promise.all(ids.map(id => api.episodes.scan(id)))
    const { activeShowId } = get()
    if (activeShowId) setTimeout(() => get().loadEpisodes(activeShowId), 1000)
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
    set(state => ({
      episodes: state.episodes.map(ep => {
        if (ep.id !== episodeId) return ep
        const isDone = message === 'Complete' || percent >= 100
        return { ...ep, progress: percent, status: isDone ? 'done' : 'downloading' }
      }),
    }))
    if (message === 'Complete' || percent >= 100) {
      get().detachSSE(episodeId)
      get().loadGlobalStatus()
    }
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
    // Optimistic update
    set(state => ({ workerStatus: { ...state.workerStatus, max_jobs: clamped } }))
    try {
      await api.worker.setMaxJobs(clamped)
    } catch {
      // Backend not yet implemented
    }
  },

  restartWorker: async () => {
    try {
      await api.worker.restart()
    } catch {
      // Backend not yet implemented
    }
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
}))

// Convenience selector for episode counts per filter tab
export function useTabCounts() {
  return useStore(useShallow(state => {
    const eps = state.episodes
    return {
      all:         eps.length,
      not_started: eps.filter(e => e.status === 'pending').length,
      pending:     eps.filter(e => e.status === 'queued' || e.status === 'downloading').length,
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
        case 'pending':     return ep.status === 'queued' || ep.status === 'downloading'
        case 'done':        return ep.status === 'done'
        case 'failed':      return ep.status === 'failed'
      }
    }
    return eps.filter(filterFn).map(e => (e as Episode).id)
  }))
}
