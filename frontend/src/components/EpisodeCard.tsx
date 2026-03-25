import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import s from './EpisodeCard.module.css'

interface Props {
  episodeId: number
}

export function EpisodeCard({ episodeId }: Props) {
  const ep = useStore(state => state.episodes.find(e => e.id === episodeId))
  const isSelected = useStore(state => state.selectedIds.has(episodeId))
  const { toggleSelected, downloadEpisodes, cancelEpisode, resetEpisode } = useStore(useShallow(state => ({
    toggleSelected:   state.toggleSelected,
    downloadEpisodes: state.downloadEpisodes,
    cancelEpisode:    state.cancelEpisode,
    resetEpisode:     state.resetEpisode,
  })))

  const [preferredSource, setPreferredSource] = useState<string>('')

  if (!ep) return null

  const pct = Math.round(ep.progress || 0)
  const badge = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`

  const statusText = {
    pending:     'not started',
    queued:      'queued',
    downloading: `downloading ${pct}%`,
    done:        'done',
    failed:      'failed',
  }[ep.status] ?? ep.status

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
            <div className={`${s.dot} ${s[ep.status]}`} />
            <span className={s.statusText}>{statusText}</span>
          </div>
        </div>

        {/* Source selector */}
        <div>
          {ep.sources && ep.sources.length > 0 ? (
            <select
              className={s.sourceSelect}
              value={preferredSource}
              onChange={e => setPreferredSource(e.target.value)}
              title="Preferred source"
            >
              <option value="">Auto</option>
              {ep.sources.map((src, i) => (
                <option key={i} value={src.label}>{src.label}</option>
              ))}
            </select>
          ) : (
            <span className={s.sourceEmpty}>no sources</span>
          )}
        </div>

        {/* Actions */}
        <div className={s.actions}>
          {ep.status !== 'done' && (
            <button
              className={`${s.btn} ${s.btnDownload}`}
              onClick={() => downloadEpisodes([ep.id], preferredSource || undefined)}
              title="Download"
            >
              ↓
            </button>
          )}
          {ep.status === 'done' && (
            <button
              className={`${s.btn} ${s.btnGhost}`}
              onClick={() => resetEpisode(ep.id)}
              title="Re-download"
            >
              ↺
            </button>
          )}
          {ep.status === 'downloading' && (
            <button
              className={`${s.btn} ${s.btnGhost}`}
              onClick={() => cancelEpisode(ep.id)}
              title="Stop"
            >
              ■
            </button>
          )}
          {ep.status === 'failed' && (
            <button
              className={`${s.btn} ${s.btnGhost}`}
              onClick={() => resetEpisode(ep.id)}
              title="Reset to pending"
            >
              ↺
            </button>
          )}
          <button
            className={`${s.btn} ${s.btnReport}`}
            title={ep.error ? 'View report' : 'No report available'}
            disabled={!ep.error && ep.status !== 'failed'}
          >
            ☰
          </button>
        </div>
      </div>

      {ep.status === 'failed' && ep.error && (
        <div className={s.errorText}>{ep.error}</div>
      )}

      <div className={s.progressBar}>
        <div className={s.progressFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
