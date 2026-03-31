import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api/client'
import type { ActiveEpisode } from '../api/types'
import s from './QueuePanel.module.css'

interface Props {
  onClose: () => void
}

const STATUS_LABEL: Record<string, string> = {
  queued:     'queued',
  downloading: 'downloading',
  cancelling:  'cancelling',
}

export function QueuePanel({ onClose }: Props) {
  const [episodes, setEpisodes] = useState<ActiveEpisode[]>([])
  const [loading, setLoading] = useState(true)

  const selectShow = useStore(state => state.selectShow)

  const load = useCallback(async () => {
    try {
      const data = await api.episodes.active()
      setEpisodes(data)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 3000)
    return () => clearInterval(interval)
  }, [load])

  // Group by show preserving insertion order
  const groups: { showId: number; showTitle: string; episodes: ActiveEpisode[] }[] = []
  const seen = new Map<number, number>() // showId → groups index
  for (const ep of episodes) {
    if (!seen.has(ep.show_id)) {
      seen.set(ep.show_id, groups.length)
      groups.push({ showId: ep.show_id, showTitle: ep.show_title, episodes: [] })
    }
    groups[seen.get(ep.show_id)!].episodes.push(ep)
  }

  async function handleShowClick(showId: number) {
    onClose()
    await selectShow(showId)
  }

  return (
    <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={s.panel}>
        <div className={s.header}>
          <span className={s.title}>Active Queue</span>
          {episodes.length > 0 && (
            <span className={s.count}>{episodes.length} episode{episodes.length !== 1 ? 's' : ''}</span>
          )}
          <button className={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={s.body}>
          {loading && episodes.length === 0 ? (
            <p className={s.empty}>Loading…</p>
          ) : episodes.length === 0 ? (
            <p className={s.empty}>Queue is empty.</p>
          ) : (
            groups.map(group => (
              <div key={group.showId} className={s.showGroup}>
                <button className={s.showTitle} onClick={() => handleShowClick(group.showId)}>
                  {group.showTitle}
                </button>
                {group.episodes.map(ep => (
                  <div key={ep.id} className={`${s.row} ${s[ep.status]}`}>
                    <div className={`${s.dot} ${s[`dot_${ep.status}`]}`} />
                    <span className={s.epCode}>
                      S{String(ep.season).padStart(2, '0')}E{String(ep.episode).padStart(2, '0')}
                    </span>
                    <span className={s.epTitle}>{ep.title}</span>
                    <div className={s.statusArea}>
                      {ep.status === 'downloading' ? (
                        <div className={s.progressWrap}>
                          <div className={s.progressBar}>
                            <div className={s.progressFill} style={{ width: `${ep.progress}%` }} />
                          </div>
                          <span className={s.progressPct}>{Math.round(ep.progress)}%</span>
                        </div>
                      ) : (
                        <span className={s.statusBadge}>{STATUS_LABEL[ep.status] ?? ep.status}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
