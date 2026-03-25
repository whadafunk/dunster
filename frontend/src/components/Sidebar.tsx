import { useEffect, useRef, useState } from 'react'

function cleanTitle(raw: string): string {
  const yearMatch = raw.match(/^(.+?\(\d{4}\))/)
  if (yearMatch) return yearMatch[1].trim()
  return raw.split(/\s*\|\s*|\s+Online\b/)[0].trim()
}
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import s from './Sidebar.module.css'

export function Sidebar() {
  const { shows, activeShowId, loadShows, addShow, deleteShow, selectShow } = useStore(useShallow(state => ({
    shows: state.shows,
    activeShowId: state.activeShowId,
    loadShows: state.loadShows,
    addShow: state.addShow,
    deleteShow: state.deleteShow,
    selectShow: state.selectShow,
  })))

  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadShows() }, [loadShows])

  async function handleAdd() {
    if (!url.trim()) return
    setAdding(true)
    try {
      await addShow(url.trim())
      setUrl('')
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(e: React.MouseEvent, showId: number) {
    e.stopPropagation()
    if (!confirm('Remove this show? Downloads are kept.')) return
    await deleteShow(showId)
  }

  return (
    <aside className={s.sidebar}>
      <div className={s.sidebarHeader}>
        <h2>Shows</h2>
        <div className={s.addForm}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Paste show page URL…"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button className={s.addBtn} onClick={handleAdd} disabled={adding}>
            {adding ? '…' : 'Add'}
          </button>
        </div>
      </div>

      <div className={s.showsList}>
        {shows.length === 0 ? (
          <div className={s.empty}>
            📺<br />No shows yet.<br />Paste a show URL above.
          </div>
        ) : (
          shows.map(show => (
            <div
              key={show.id}
              className={`${s.showItem} ${show.id === activeShowId ? s.active : ''}`}
              onClick={() => selectShow(show.id)}
            >
              <div className={s.showIcon}>📺</div>
              <div className={s.showInfo}>
                <div className={s.showTitle}>{show.title ? cleanTitle(show.title) : 'Loading…'}</div>
                <div className={s.showMeta}>{show.done_count}/{show.episode_count} done</div>
              </div>
              <button className={s.deleteBtn} onClick={e => handleDelete(e, show.id)}>✕</button>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
