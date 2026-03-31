import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import s from './DownloaderWidget.module.css'

interface Props {
  className?: string
}

export function DownloaderWidget({ className }: Props) {
  const [open, setOpen] = useState(false)
  const { downloaderStatus, stopDownloaders } = useStore(useShallow(state => ({
    downloaderStatus: state.downloaderStatus,
    stopDownloaders:  state.stopDownloaders,
  })))

  const { active, orphans } = downloaderStatus
  const hasOrphans = orphans > 0
  const hasActive  = active > 0

  const dotClass = hasOrphans
    ? s.orphan
    : hasActive
    ? s.active
    : s.idle

  const statusMessage = hasOrphans
    ? `${active} yt-dlp process${active !== 1 ? 'es' : ''} running, ${orphans} orphaned (not tracked by worker).`
    : hasActive
    ? `${active} yt-dlp process${active !== 1 ? 'es' : ''} running normally.`
    : 'No yt-dlp processes running.'

  function handleStop(mode: 'all' | 'orphans') {
    stopDownloaders(mode)
    setOpen(false)
  }

  return (
    <>
      <button className={`${className ?? ''} ${s.widget}`} onClick={() => setOpen(true)}>
        <div className={`${s.statusDot} ${dotClass}`} />
        <span className={s.label}>Downloader</span>
      </button>

      {open && (
        <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div className={s.modal}>
            <div className={s.modalHeader}>
              <div className={`${s.modalDot} ${dotClass}`} />
              <span className={s.modalTitle}>Downloader Status</span>
            </div>
            <p className={s.modalMessage}>{statusMessage}</p>
            <div className={s.modalActions}>
              <button className={s.actionBtn} onClick={() => handleStop('all')} disabled={!hasActive && !hasOrphans}>
                Stop all
              </button>
              <button className={s.actionBtn} onClick={() => handleStop('orphans')} disabled={!hasOrphans}>
                Stop orphans
              </button>
              <button className={s.actionBtn} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
