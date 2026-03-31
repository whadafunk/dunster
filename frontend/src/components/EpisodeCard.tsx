import { useState, useMemo } from 'react'
import { Download, ExternalLink, FileText, Loader2, RotateCcw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { SourceAttempt } from '../api/types'
import s from './EpisodeCard.module.css'

interface Props {
  episodeId: number
}

function parseSpeedToken(msg: string): string {
  if (!msg) return ''
  const token = msg.split(' ')[0]
  return /^[\d.]+(B|KB|KiB|MB|MiB|GB|GiB)\/s$/i.test(token) ? token : ''
}

export function EpisodeCard({ episodeId }: Props) {
  const ep = useStore(state => state.episodes.find(e => e.id === episodeId))
  const isSelected = useStore(state => state.selectedIds.has(episodeId))
  const isScanning = useStore(state => state.scanningIds.has(episodeId))
  const activityMessage = useStore(state => state.episodeMessages.get(episodeId) ?? '')
  const { toggleSelected, downloadEpisodes, cancelEpisode, resetEpisode, downloadSubsOnly } = useStore(useShallow(state => ({
    toggleSelected:   state.toggleSelected,
    downloadEpisodes: state.downloadEpisodes,
    cancelEpisode:    state.cancelEpisode,
    resetEpisode:     state.resetEpisode,
    downloadSubsOnly: state.downloadSubsOnly,
  })))

  const subsStatus = ep?.subtitle_status ?? null
  const subsHave = !!(ep?.subtitle_langs)   // non-null, non-empty → subs on disk
  const subsWaitingCDN = subsStatus === 'pending' && activityMessage.startsWith('Waiting for CDN slot (subs)')

  const [preferredSource, setPreferredSource] = useState<string>('')
  const [reportOpen, setReportOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetOpts, setResetOpts] = useState({ deleteFile: false, deleteTemp: true, deleteLog: true })

  // Sort sources by global priority from settings; unknowns go last
  const sortedSources = useMemo(() => {
    if (!ep?.sources?.length) return []
    try {
      const cfg = JSON.parse(localStorage.getItem('streamgrabber_config') || '{}')
      const priority: string[] = cfg.sourcePriority || []
      if (!priority.length) return ep.sources
      return [...ep.sources].sort((a, b) => {
        const ai = priority.indexOf(a.key)
        const bi = priority.indexOf(b.key)
        if (ai === -1 && bi === -1) return 0
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
    } catch {
      return ep.sources
    }
  }, [ep?.sources])

  if (!ep) return null

  const pct = Math.round(ep.progress || 0)
  const badge = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`

  const isCancelling = ep.status === 'cancelling'

  // Speed extracted from activity message (e.g. "1.5MiB/s ETA 03:00" → "1.5MiB/s")
  const speed = ep.status === 'downloading' ? parseSpeedToken(activityMessage) : ''

  // Activity line shown below the title — speed+ETA or source-switch messages
  const showActivity = (ep.status === 'downloading' && !!activityMessage) || subsWaitingCDN

  const isCdnWaiting = ep.status === 'downloading' && activityMessage.startsWith('Waiting for CDN')

  const dotClass = isScanning ? s.scanning
    : isCancelling ? s.stopping
    : isCdnWaiting ? s.cdnWaiting
    : s[ep.status] ?? s.pending

  const statusText = isScanning
    ? 'scanning sources'
    : isCancelling
    ? 'stopping…'
    : isCdnWaiting
    ? 'waiting for CDN slot'
    : ({
        pending:     'not started',
        queued:      'queued',
        downloading: `downloading ${pct}%`,
        cancelling:  'stopping…',
        cancelled:   'incomplete',
        done:        'done',
        failed:      'failed',
      } as Record<string, string>)[ep.status] ?? ep.status

  const hasReport = ep.status === 'done' || ep.status === 'failed' || !!(ep.scanned_at || ep.error)

  return (
    <div className={`${s.card} ${isSelected ? s.selected : ''}`} data-status={ep.status}>
      <div className={s.row}>
        <input
          type="checkbox"
          className={s.checkbox}
          checked={isSelected}
          onChange={() => toggleSelected(ep.id)}
        />

        <span className={s.badge}>{badge}</span>

        <div className={s.info}>
          <div className={s.title}>{ep.title}</div>
          <div className={s.statusLine}>
            <div className={`${s.dot} ${dotClass}`} />
            <span className={s.statusText}>{statusText}</span>
            {speed && <span className={s.speedBadge}>{speed}</span>}
          </div>
          {showActivity && (
            <div className={s.activityMessage}>
              {subsWaitingCDN ? 'subs: waiting for CDN slot' : activityMessage}
            </div>
          )}
        </div>

        {/* Source selector — when not started or incomplete */}
        {(ep.status === 'pending' || ep.status === 'cancelled') && (
          <div>
            {sortedSources.length > 0 ? (
              <select
                className={s.sourceSelect}
                value={preferredSource || sortedSources[0]?.label}
                onChange={e => setPreferredSource(e.target.value)}
                title="Preferred source"
              >
                {sortedSources.map((src, i) => (
                  <option key={i} value={src.label}>{src.label}</option>
                ))}
              </select>
            ) : (
              <span className={s.sourceEmpty}>no sources</span>
            )}
          </div>
        )}

        {/* Actions — one primary action button at a time */}
        <div className={s.actions}>
          {(ep.status === 'pending' || ep.status === 'cancelled') && (
            <button
              className={`${s.btn} ${s.btnDownload}`}
              onClick={() => downloadEpisodes([ep.id], preferredSource || undefined)}
              title={ep.status === 'cancelled' ? 'Retry download' : 'Download'}
            >
              <Download size={14} strokeWidth={2.5} />
            </button>
          )}
          {ep.status === 'queued' && (
            <button
              className={`${s.btn} ${s.btnGhost}`}
              disabled
              title="Waiting in queue"
            >
              ■
            </button>
          )}
          {(ep.status === 'downloading' || ep.status === 'cancelling') && (
            <button
              className={`${s.btn} ${s.btnGhost} ${isCancelling ? s.btnStopping : ''}`}
              onClick={isCancelling ? undefined : () => cancelEpisode(ep.id)}
              title={isCancelling ? 'Stopping…' : 'Stop'}
            >
              ■
            </button>
          )}
          {!['queued', 'downloading', 'cancelling'].includes(ep.status) && (
            <button
              className={`${s.btn} ${
                subsWaitingCDN          ? s.btnSubsWaiting
                : subsStatus === 'pending' ? s.btnSubsPending
                : subsHave              ? s.btnSubsDone
                : s.btnSubs
              }`}
              onClick={() => subsStatus !== 'pending' && !subsHave && downloadSubsOnly(ep.id)}
              disabled={subsStatus === 'pending' || subsHave}
              title={
                subsWaitingCDN          ? 'Waiting for CDN slot (subtitles)'
                : subsStatus === 'pending' ? 'Downloading subtitles…'
                : subsHave              ? `Subtitles: ${ep.subtitle_langs}`
                : 'Download subtitles only'
              }
            >
              {subsStatus === 'pending'
                ? <Loader2 size={13} strokeWidth={2.5} className={s.spin} />
                : <FileText size={13} strokeWidth={2.5} />}
            </button>
          )}
          {(ep.status === 'done' || ep.status === 'failed' || ep.status === 'cancelled') && (
            <button
              className={`${s.btn} ${s.btnGhost}`}
              onClick={() => {
                if (confirmReset) { setConfirmReset(false); return }
                setResetOpts({
                  deleteTemp: ep.status !== 'done',
                  deleteLog:  ep.status !== 'done',
                  deleteFile: ep.status !== 'done',
                })
                setConfirmReset(true)
              }}
              title="Reset state"
            >
              <RotateCcw size={13} strokeWidth={2.5} />
            </button>
          )}
          <a
            className={`${s.btn} ${s.btnLink}`}
            href={ep.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open episode page"
          >
            <ExternalLink size={13} strokeWidth={2.5} />
          </a>
          <button
            className={`${s.btn} ${s.btnReport} ${reportOpen ? s.btnReportActive : ''}`}
            title={hasReport ? 'View scan report' : 'No report yet'}
            disabled={!hasReport}
            onClick={() => setReportOpen(o => !o)}
          >
            ☰
          </button>
        </div>
      </div>

      {confirmReset && ep.status === 'done' && (
        <div className={s.confirmDialog}>
          <span className={s.confirmText}>
            Delete <span className={s.confirmFilename}>{ep.file_path?.split('/').pop()}</span> from disk?
          </span>
          <div className={s.confirmBtns}>
            <button className={s.confirmBtn} onClick={() => setConfirmReset(false)}>Cancel</button>
            <button className={s.confirmBtn} onClick={() => { setConfirmReset(false); resetEpisode(ep.id, {}) }}>
              Keep file
            </button>
            <button
              className={`${s.confirmBtn} ${s.confirmBtnDanger}`}
              onClick={() => { setConfirmReset(false); resetEpisode(ep.id, { deleteFile: true }) }}
            >
              Delete file
            </button>
          </div>
        </div>
      )}

      {confirmReset && (ep.status === 'failed' || ep.status === 'cancelled') && (
        <div className={s.confirmDialog}>
          <span className={s.confirmText}>Reset episode — choose what to clean up:</span>
          <div className={s.resetChecks}>
            <label className={s.resetCheck}>
              <input
                type="checkbox"
                checked={resetOpts.deleteTemp}
                onChange={e => setResetOpts(o => ({ ...o, deleteTemp: e.target.checked }))}
              />
              <span>Delete temp files (.part, segments)</span>
            </label>
            <label className={s.resetCheck}>
              <input
                type="checkbox"
                checked={resetOpts.deleteLog}
                onChange={e => setResetOpts(o => ({ ...o, deleteLog: e.target.checked }))}
              />
              <span>Delete episode log</span>
            </label>
            {ep.file_path && (
              <label className={s.resetCheck}>
                <input
                  type="checkbox"
                  checked={resetOpts.deleteFile}
                  onChange={e => setResetOpts(o => ({ ...o, deleteFile: e.target.checked }))}
                />
                <span>Delete video file ({ep.file_path.split('/').pop()})</span>
              </label>
            )}
          </div>
          <div className={s.confirmBtns}>
            <button className={s.confirmBtn} onClick={() => setConfirmReset(false)}>Cancel</button>
            <button
              className={`${s.confirmBtn} ${s.confirmBtnDanger}`}
              onClick={() => { setConfirmReset(false); resetEpisode(ep.id, resetOpts) }}
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {ep.status === 'failed' && ep.error && (
        <div className={s.errorText}>{ep.error}</div>
      )}

      {reportOpen && hasReport && (
        <div className={s.reportPanel}>
          {ep.scanned_at && (
            <div className={s.reportSection}>
              <span className={s.reportLabel}>scanned</span>
              <span className={s.reportValue}>
                {new Date(ep.scanned_at + 'Z').toLocaleString()}
              </span>
            </div>
          )}

          {ep.subtitle_langs != null && ep.status !== 'done' && (
            <div className={s.reportSection}>
              <span className={s.reportLabel}>subtitles</span>
              <span className={ep.subtitle_langs ? s.reportValue : `${s.reportValue} ${s.reportMuted}`}>
                {ep.subtitle_langs ? ep.subtitle_langs.split(',').join(', ') : 'no subtitles found'}
              </span>
            </div>
          )}

          {ep.status === 'done' && (<>
            {ep.downloaded_via && (
              <div className={s.reportSection}>
                <span className={s.reportLabel}>source</span>
                <span className={s.reportValue}>{ep.downloaded_via}</span>
              </div>
            )}
            {ep.downloaded_at && (
              <div className={s.reportSection}>
                <span className={s.reportLabel}>finished</span>
                <span className={s.reportValue}>
                  {new Date(ep.downloaded_at + 'Z').toLocaleString()}
                  {ep.download_elapsed != null && (
                    <span className={s.reportMuted}>
                      {' '}({Math.floor(ep.download_elapsed / 60)}m {Math.round(ep.download_elapsed % 60)}s)
                    </span>
                  )}
                </span>
              </div>
            )}
            {ep.file_path && (<>
              <div className={s.reportSection}>
                <span className={s.reportLabel}>file</span>
                <span className={s.reportValue}>{ep.file_path.split('/').pop()}</span>
              </div>
              <div className={s.reportSection}>
                <span className={s.reportLabel}></span>
                <span className={`${s.reportValue} ${s.reportMuted} ${s.reportPath}`}>{ep.file_path}</span>
              </div>
            </>)}
            {ep.file_size != null && (
              <div className={s.reportSection}>
                <span className={s.reportLabel}>size</span>
                <span className={s.reportValue}>
                  {(ep.file_size / 1024 / 1024).toFixed(1)} MB
                </span>
              </div>
            )}
            {ep.subtitle_langs != null && (
              <div className={s.reportSection}>
                <span className={s.reportLabel}>subtitles</span>
                <span className={ep.subtitle_langs ? s.reportValue : `${s.reportValue} ${s.reportMuted}`}>
                  {ep.subtitle_langs
                    ? ep.subtitle_langs.split(',').join(', ')
                    : 'no subtitles found'}
                </span>
              </div>
            )}
          </>)}

          {ep.status === 'failed' && (<>
            {ep.source_attempts && ep.source_attempts.length > 0 && (
              ep.source_attempts.map((a: SourceAttempt, i: number) => (
                <div key={i} className={s.reportSection}>
                  <span className={s.reportLabel}>{i === 0 ? 'tried' : ''}</span>
                  <span className={s.reportValue}>
                    {a.label}
                    {a.error && (
                      <span className={s.reportError}> — {a.error}</span>
                    )}
                  </span>
                </div>
              ))
            )}
            {ep.error && (
              <div className={s.reportSection}>
                <span className={s.reportLabel}>error</span>
                <span className={`${s.reportValue} ${s.reportError}`}>{ep.error}</span>
              </div>
            )}
          </>)}
        </div>
      )}

    </div>
  )
}
