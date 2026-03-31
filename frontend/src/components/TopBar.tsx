import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { Logo } from './Logo'
import { WorkerWidget } from './WorkerWidget'
import { DownloaderWidget } from './DownloaderWidget'
import { QueuePanel } from './QueuePanel'
import s from './TopBar.module.css'

function formatBandwidth(bps: number | null): string {
  if (bps === null) return '—'
  if (bps < 1024) return `${bps} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function TopBar() {
  const [queueOpen, setQueueOpen] = useState(false)

  const { systemMetrics, workerStatus, setConfigOpen, loadSystemMetrics, loadGlobalStatus, loadWorkerStatus, loadDownloaderStatus, loadShows, loadFolders } =
    useStore(useShallow(state => ({
      systemMetrics:          state.systemMetrics,
      workerStatus:           state.workerStatus,
      setConfigOpen:          state.setConfigOpen,
      loadSystemMetrics:      state.loadSystemMetrics,
      loadGlobalStatus:       state.loadGlobalStatus,
      loadWorkerStatus:       state.loadWorkerStatus,
      loadDownloaderStatus:   state.loadDownloaderStatus,
      loadShows:              state.loadShows,
      loadFolders:            state.loadFolders,
    })))

  useEffect(() => {
    loadGlobalStatus()
    loadWorkerStatus()
    loadSystemMetrics()
    loadDownloaderStatus()
    loadShows()
    loadFolders()
    const interval = setInterval(() => {
      loadGlobalStatus()
      loadWorkerStatus()
      loadSystemMetrics()
      loadDownloaderStatus()
      loadShows()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadGlobalStatus, loadWorkerStatus, loadSystemMetrics, loadDownloaderStatus, loadShows, loadFolders])

  const { active_downloads, cdn_waiting, max_downloads, queue_count } = systemMetrics
  const { active_jobs, configured_max_jobs } = workerStatus

  return (
    <>
      <header className={s.bar}>
        <div className={s.brand}>
          <Logo />
          <div>
            <div className={s.brandName}>Dunster <span>/ Stream Downloader</span></div>
            <div className={s.brandSub}>powered by yt-dlp</div>
          </div>
        </div>

        <button className={s.controlBtn} onClick={() => setConfigOpen(true)}>
          ⚙ Setup
        </button>

        <WorkerWidget className={s.controlBtn} />
        <DownloaderWidget className={s.controlBtn} />

        <div className={s.spacer} />

        <div className={s.metrics}>
          {/* Queued — clickable, opens queue panel */}
          <button className={`${s.metric} ${s.metricBtn}`} onClick={() => setQueueOpen(true)}>
            <span className={queue_count > 0 ? s.metricValue : s.metricNull}>{queue_count}</span>
            <span className={s.metricLabel}>queued</span>
          </button>

          <div className={s.metric}>
            <span className={active_jobs > 0 ? s.metricValue : s.metricNull}>
              {active_jobs} / {configured_max_jobs}
            </span>
            <span className={s.metricLabel}>jobs</span>
          </div>

          {/* Downloads — hover tooltip with CDN detail */}
          <div className={`${s.metric} ${s.metricHoverable}`}>
            <span className={active_downloads > 0 ? s.metricValue : s.metricNull}>
              {active_downloads} / {max_downloads}
            </span>
            <span className={s.metricLabel}>downloads</span>
            <div className={s.dlTooltip}>
              <div className={s.dlStat}>
                <span className={cdn_waiting > 0 ? s.dlStatValue : s.dlStatNull}>{cdn_waiting}</span>
                <span className={s.dlStatLabel}>waiting for CDN</span>
              </div>
              <div className={s.dlDivider} />
              <div className={s.dlStat}>
                <span className={active_downloads > 0 ? s.dlStatValue : s.dlStatNull}>{active_downloads}</span>
                <span className={s.dlStatLabel}>yt-dlp processes</span>
              </div>
              <div className={s.dlDivider} />
              <div className={s.dlStat}>
                <span className={s.dlStatValue}>{max_downloads}</span>
                <span className={s.dlStatLabel}>max concurrent</span>
              </div>
            </div>
          </div>

          <div className={s.metric}>
            <span className={systemMetrics.bandwidth_bps !== null ? s.metricValue : s.metricNull}>
              {formatBandwidth(systemMetrics.bandwidth_bps)}
            </span>
            <span className={s.metricLabel}>bandwidth</span>
          </div>
          <div className={s.metric}>
            <span className={systemMetrics.public_ip ? s.metricValue : s.metricNull}>
              {systemMetrics.public_ip ?? '—'}
            </span>
            <span className={s.metricLabel}>public ip</span>
          </div>
          <div className={s.metric}>
            <span className={systemMetrics.uptime_seconds !== null ? s.metricValue : s.metricNull}>
              {formatUptime(systemMetrics.uptime_seconds)}
            </span>
            <span className={s.metricLabel}>uptime</span>
          </div>
        </div>
      </header>

      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
    </>
  )
}
