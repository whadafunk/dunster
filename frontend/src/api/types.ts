export interface Source {
  label: string
  url: string
  referer?: string
}

export type EpisodeStatus = 'pending' | 'queued' | 'downloading' | 'done' | 'failed'

export type FilterTab = 'all' | 'not_started' | 'pending' | 'done' | 'failed'

export interface Episode {
  id: number
  show_id: number
  url: string
  title: string
  season: number
  episode: number
  status: EpisodeStatus
  progress: number
  sources: Source[]
  error?: string
}

export interface Show {
  id: number
  url: string
  title: string
  episode_count: number
  done_count: number
  scraped_at: string
}

export interface GlobalStatus {
  total: number
  done: number
  failed: number
  downloading: number
  queued: number
  pending: number
}

export interface WorkerStatus {
  running: boolean
  active_jobs: number
  queued_jobs: number
  max_jobs: number
}

export interface SystemMetrics {
  queue_count: number
  bandwidth_bps: number | null
  public_ip: string | null
  uptime_seconds: number | null
}

export interface ProgressEvent {
  episode_id: number
  percent: number
  message: string
}
