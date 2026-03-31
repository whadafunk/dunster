import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { api } from '../api/client'
import type { ActiveDownload } from '../api/types'
import s from './WorkerWidget.module.css'

interface Props {
  className?: string
}

export function WorkerWidget({ className }: Props) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownload[]>([])
  const [loadingDownloads, setLoadingDownloads] = useState(false)
  const [flushing, setFlushing] = useState(false)
  const [flushResult, setFlushResult] = useState<number | null>(null)
  const [togglingPause, setTogglingPause] = useState(false)

  const { workerStatus, restartWorker, flushQueue, togglePause } = useStore(useShallow(state => ({
    workerStatus:  state.workerStatus,
    restartWorker: state.restartWorker,
    flushQueue:    state.flushQueue,
    togglePause:   state.togglePause,
  })))

  const needsRestart = workerStatus.configured_max_jobs !== workerStatus.max_jobs

  const dotClass = !workerStatus.running
    ? s.stopped
    : workerStatus.active_jobs > 0
    ? s.runningActive
    : s.running

  const statusMessage = !workerStatus.running
    ? 'Worker is not running.'
    : workerStatus.paused
    ? 'Worker is paused — no new downloads will be queued.'
    : needsRestart
    ? `Worker running — restart required to apply new concurrency (${workerStatus.max_jobs} → ${workerStatus.configured_max_jobs} jobs).`
    : `Worker running fine with ${workerStatus.configured_max_jobs} max concurrent job${workerStatus.configured_max_jobs !== 1 ? 's' : ''}.`

  async function handleRestartClick() {
    setLoadingDownloads(true)
    try {
      const downloads = await api.worker.activeDownloads()
      setActiveDownloads(downloads)
    } catch {
      setActiveDownloads([])
    } finally {
      setLoadingDownloads(false)
    }
    setConfirming(true)
  }

  async function handleConfirm(mode: 'graceful' | 'immediate') {
    restartWorker(mode)
    setConfirming(false)
    setOpen(false)
  }

  async function handleFlushQueue() {
    setFlushing(true)
    setFlushResult(null)
    try {
      const count = await flushQueue()
      setFlushResult(count)
    } finally {
      setFlushing(false)
    }
  }

  async function handleTogglePause() {
    setTogglingPause(true)
    try {
      await togglePause()
    } finally {
      setTogglingPause(false)
    }
  }

  function handleClose() {
    setOpen(false)
    setConfirming(false)
    setActiveDownloads([])
    setFlushResult(null)
  }

  return (
    <>
      <button className={`${className ?? ''} ${s.widget}`} onClick={() => setOpen(true)}>
        <div className={`${s.statusDot} ${dotClass}`} />
        <span className={s.label}>{workerStatus.paused ? 'Worker (paused)' : 'Worker'}</span>
      </button>

      {open && (
        <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) handleClose() }}>
          <div className={s.modal}>
            {!confirming ? (
              <>
                <div className={s.modalHeader}>
                  <div className={`${s.modalDot} ${dotClass}`} />
                  <span className={s.modalTitle}>Worker Status</span>
                </div>
                <p className={s.modalMessage}>{statusMessage}</p>
                {workerStatus.last_warning && (
                  <div className={s.lastWarning}>
                    <span className={s.warningLabel}>last warning</span>
                    <span className={s.warningText}>{workerStatus.last_warning}</span>
                  </div>
                )}
                {flushResult !== null && (
                  <p className={s.flushResult}>
                    {flushResult === 0 ? 'Queue was already empty.' : `${flushResult} queued episode${flushResult !== 1 ? 's' : ''} moved back to pending.`}
                  </p>
                )}
                <div className={s.modalActions}>
                  <button
                    className={`${s.actionBtn} ${s.actionBtnPrimary}`}
                    onClick={handleRestartClick}
                    disabled={loadingDownloads}
                  >
                    {loadingDownloads ? 'Checking…' : 'Restart worker'}
                  </button>
                  <button
                    className={`${s.actionBtn} ${workerStatus.paused ? s.actionBtnPaused : ''}`}
                    onClick={handleTogglePause}
                    disabled={togglingPause}
                  >
                    {togglingPause ? '…' : workerStatus.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    className={s.actionBtn}
                    onClick={handleFlushQueue}
                    disabled={flushing}
                  >
                    {flushing ? 'Flushing…' : 'Flush Queue'}
                  </button>
                  <button className={s.actionBtn} onClick={handleClose}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={s.modalHeader}>
                  <span className={s.modalTitle}>Restart Worker</span>
                </div>

                {activeDownloads.length > 0 ? (
                  <>
                    <p className={s.modalMessage}>
                      {activeDownloads.length} download{activeDownloads.length !== 1 ? 's' : ''} currently in progress:
                    </p>
                    <ul className={s.downloadList}>
                      {activeDownloads.map(d => (
                        <li key={d.id} className={s.downloadItem}>
                          <span className={s.downloadShow}>{d.show_title}</span>
                          <span className={s.downloadTitle}>{d.title}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className={s.modalMessage}>No downloads currently in progress.</p>
                )}

                <div className={s.restartOptions}>
                  <div className={s.restartOption}>
                    <button
                      className={`${s.actionBtn} ${s.actionBtnPrimary}`}
                      onClick={() => handleConfirm('graceful')}
                    >
                      Graceful
                    </button>
                    <span className={s.restartHint}>Wait for current downloads to finish, then restart.</span>
                  </div>
                  <div className={s.restartOption}>
                    <button
                      className={`${s.actionBtn} ${s.actionBtnDanger}`}
                      onClick={() => handleConfirm('immediate')}
                    >
                      Immediate
                    </button>
                    <span className={s.restartHint}>Kill downloads now and restart. Interrupted episodes reset to pending.</span>
                  </div>
                </div>

                <div className={s.modalActions}>
                  <button className={s.actionBtn} onClick={() => setConfirming(false)}>
                    Back
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
