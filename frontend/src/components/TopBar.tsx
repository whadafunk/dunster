import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { Logo } from './Logo'
import { WorkerWidget } from './WorkerWidget'
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
  const { systemMetrics, globalStatus, setConfigOpen, loadSystemMetrics, loadGlobalStatus, loadWorkerStatus } =
    useStore(useShallow(state => ({
      systemMetrics:     state.systemMetrics,
      globalStatus:      state.globalStatus,
      setConfigOpen:     state.setConfigOpen,
      loadSystemMetrics: state.loadSystemMetrics,
      loadGlobalStatus:  state.loadGlobalStatus,
      loadWorkerStatus:  state.loadWorkerStatus,
    })))

  useEffect(() => {
    loadGlobalStatus()
    loadWorkerStatus()
    loadSystemMetrics()
    const interval = setInterval(() => {
      loadGlobalStatus()
      loadWorkerStatus()
      loadSystemMetrics()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadGlobalStatus, loadWorkerStatus, loadSystemMetrics])

  const queueCount = globalStatus.pending

  return (
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

      <div className={s.spacer} />

      <div className={s.metrics}>
        <div className={s.metric}>
          <span className={queueCount > 0 ? s.metricValue : s.metricNull}>{queueCount}</span>
          <span className={s.metricLabel}>queued</span>
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
  )
}
