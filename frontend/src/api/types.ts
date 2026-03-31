export interface Source {
  key: string      // canonical CDN identifier (e.g. "f16px", "myvidplay") — stable across sites
  label: string    // display string (e.g. "VideoVard (f16px)")
  url: string
  referer?: string
  embed_url?: string  // original embed URL with subtitle params (c1_file, sub_file etc.) before stripping
}

export type EpisodeStatus = 'pending' | 'queued' | 'downloading' | 'cancelling' | 'cancelled' | 'done' | 'failed'

export type FilterTab = 'all' | 'not_started' | 'pending' | 'incomplete' | 'done' | 'failed'

export interface SourceAttempt {
  label: string
  error: string
}

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
  scanned_at?: string
  downloaded_via?: string
  downloaded_at?: string
  download_elapsed?: number
  file_path?: string
  file_size?: number
  source_attempts?: SourceAttempt[]
  subtitle_langs?: string | null   // comma-sep lang codes if subs downloaded, "" = none found, null = not attempted
  subtitle_status?: string | null  // null = never attempted, 'pending' = job queued, 'done' = finished, 'failed' = error
}

export interface Show {
  id: number
  url: string
  title: string
  episode_count: number
  done_count: number
  active_count: number
  scraped_at: string
  folder_id: number | null
  sort_order: number
}

export interface Folder {
  id: number
  name: string
  is_system: boolean
  sort_order: number
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
  configured_max_jobs: number
  configured_max_downloads: number
  configured_concurrent_fragments: number
  configured_bandwidth_limit: number
  last_warning: string
  orphan_count: number
  paused: boolean
}

export interface ActiveDownload {
  id: number
  title: string
  show_title: string
}

export interface ActiveEpisode {
  id: number
  show_id: number
  show_title: string
  title: string
  season: number
  episode: number
  status: EpisodeStatus
  progress: number
}

export interface DownloaderStatus {
  active: number
  orphans: number
}

export interface SystemMetrics {
  queue_count: number
  bandwidth_bps: number | null
  public_ip: string | null
  uptime_seconds: number | null
  active_downloads: number
  cdn_waiting: number
  max_downloads: number
}

export type LogLevel = 'none' | 'normal' | 'debug'

export interface LogSettings {
  log_level_worker:    LogLevel
  log_level_backend:   LogLevel
  log_level_download:  LogLevel
  log_level_episode:   LogLevel
  log_max_mb_worker:   number
  log_max_mb_backend:  number
  log_max_mb_download: number
  log_max_mb_episode:  number
}

export interface SubtitleSettings {
  enabled: boolean
  lang1: string
  lang2: string
}

export interface DownloadSettings {
  folder_per_show: boolean
  folder_per_season: boolean
  bandwidth_limit: number
}

export interface ProgressEvent {
  episode_id: number
  percent: number
  message: string
}
