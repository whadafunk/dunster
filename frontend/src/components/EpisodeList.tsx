import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, useTabCounts, useFilteredEpisodeIds } from '../store'
import { SeasonGroup } from './SeasonGroup'
import { EpisodeCard } from './EpisodeCard'
import type { Episode } from '../api/types'
import type { FilterTab } from '../api/types'
import s from './EpisodeList.module.css'

// ── Per-show UI persistence ──────────────────────────────────────────────────
// Stored in localStorage as: { [showId]: { filter, expanded: { [tab]: number[] } } }
const UI_KEY = 'sg_show_ui'

function readUi(showId: number): { filter: FilterTab; expanded: Record<string, number[]> } {
  try {
    const all = JSON.parse(localStorage.getItem(UI_KEY) || '{}')
    const s = all[String(showId)] ?? {}
    return { filter: s.filter ?? 'all', expanded: s.expanded ?? {} }
  } catch {
    return { filter: 'all', expanded: {} }
  }
}

function writeUiFilter(showId: number, filter: FilterTab) {
  try {
    const all = JSON.parse(localStorage.getItem(UI_KEY) || '{}')
    const key = String(showId)
    all[key] = { ...(all[key] ?? {}), filter }
    localStorage.setItem(UI_KEY, JSON.stringify(all))
  } catch {}
}

function writeUiExpanded(showId: number, filter: FilterTab, expanded: Set<number>) {
  try {
    const all = JSON.parse(localStorage.getItem(UI_KEY) || '{}')
    const key = String(showId)
    const prev = all[key] ?? {}
    all[key] = { ...prev, expanded: { ...(prev.expanded ?? {}), [filter]: [...expanded] } }
    localStorage.setItem(UI_KEY, JSON.stringify(all))
  } catch {}
}

const TABS: { label: string; value: FilterTab }[] = [
  { label: 'All',        value: 'all' },
  { label: 'Not Started', value: 'not_started' },
  { label: 'Pending',    value: 'pending' },
  { label: 'Incomplete', value: 'incomplete' },
  { label: 'Done',       value: 'done' },
  { label: 'Failed',     value: 'failed' },
]

function cleanTitle(raw: string): string {
  // Extract "Name (Year)" — stop at the first occurrence of " Online", " |", " –", " -  "
  const yearMatch = raw.match(/^(.+?\(\d{4}\))/)
  if (yearMatch) return yearMatch[1].trim()
  // Fallback: take the part before " | " or " Online"
  return raw.split(/\s*\|\s*|\s+Online\b/)[0].trim()
}

function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    return url
  }
}

function imdbUrl(title: string): string {
  return `https://www.imdb.com/find?q=${encodeURIComponent(title)}`
}

export function EpisodeList() {
  const {
    activeShowId, shows, episodes, filter, selectedIds,
    setFilter, selectAll, clearSelected,
    downloadEpisodes, downloadSubsOnly, removeEpisodes, resetEpisode,
    loadEpisodes, loadShows, rescanEpisodes, rediscoverEpisodes,
  } = useStore(useShallow(state => ({
    activeShowId:        state.activeShowId,
    shows:               state.shows,
    episodes:            state.episodes,
    filter:              state.filter,
    selectedIds:         state.selectedIds,
    setFilter:           state.setFilter,
    selectAll:           state.selectAll,
    clearSelected:       state.clearSelected,
    downloadEpisodes:    state.downloadEpisodes,
    downloadSubsOnly:    state.downloadSubsOnly,
    removeEpisodes:      state.removeEpisodes,
    resetEpisode:        state.resetEpisode,
    loadEpisodes:        state.loadEpisodes,
    loadShows:           state.loadShows,
    rescanEpisodes:      state.rescanEpisodes,
    rediscoverEpisodes:  state.rediscoverEpisodes,
  })))

  const counts = useTabCounts()
  const filteredIds = useFilteredEpisodeIds(filter)


  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set())
  const [rediscovering, setRediscovering] = useState(false)

  type Prompt =
    | { kind: 'remove-warn' }
    | { kind: 'remove-confirm'; deleteFiles: boolean }
    | { kind: 'reset-warn' }
    | { kind: 'reset-confirm'; deleteFiles: boolean }
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  // Track which show's UI has been initialized so we restore exactly once per show visit
  const [initializedShowId, setInitializedShowId] = useState<number | null>(null)

  // Restore saved filter + expanded seasons once episodes are available for the show
  useEffect(() => {
    if (!activeShowId || episodes.length === 0) return
    if (initializedShowId === activeShowId) return
    const ui = readUi(activeShowId)
    setFilter(ui.filter)
    const saved = ui.expanded[ui.filter]
    setExpandedSeasons(saved !== undefined
      ? new Set(saved)
      : new Set(episodes.map(e => e.season))
    )
    setInitializedShowId(activeShowId)
  }, [activeShowId, episodes.length, initializedShowId]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleTabClick(tab: FilterTab) {
    setFilter(tab)
    if (!activeShowId) return
    writeUiFilter(activeShowId, tab)
    const ui = readUi(activeShowId)
    const saved = ui.expanded[tab]
    setExpandedSeasons(saved !== undefined
      ? new Set(saved)
      : new Set(episodes.map(e => e.season))
    )
  }

  function toggleSeason(season: number) {
    setExpandedSeasons(prev => {
      const next = new Set(prev)
      next.has(season) ? next.delete(season) : next.add(season)
      if (activeShowId) writeUiExpanded(activeShowId, filter, next)
      return next
    })
  }

  function expandAll() {
    const next = new Set(Object.keys(seasons).map(Number))
    setExpandedSeasons(next)
    if (activeShowId) writeUiExpanded(activeShowId, filter, next)
  }

  function collapseAll() {
    setExpandedSeasons(new Set())
    if (activeShowId) writeUiExpanded(activeShowId, filter, new Set())
  }

  // Dismiss prompt when selection or filter changes
  useEffect(() => { setPrompt(null) }, [selectedIds.size, filter])

  // Periodic refresh
  useEffect(() => {
    if (!activeShowId) return
    const interval = setInterval(() => loadEpisodes(activeShowId), 8000)
    return () => clearInterval(interval)
  }, [activeShowId, loadEpisodes])

  if (!activeShowId) {
    return (
      <div className={s.welcome}>
        <div className={s.icon}>⬇</div>
        <h2>Select a show to get started</h2>
        <p>Add a show from the sidebar, then select episodes and download their streams.</p>
      </div>
    )
  }

  const show = shows.find(sh => sh.id === activeShowId)

  const flatView = filter === 'pending' || filter === 'incomplete' || filter === 'failed'
  const filteredEps = episodes.filter(ep => filteredIds.includes(ep.id))
  const seasons = filteredEps.reduce<Record<number, number[]>>((acc, ep) => {
    if (!acc[ep.season]) acc[ep.season] = []
    acc[ep.season].push(ep.id)
    return acc
  }, {})

  const allSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.has(id))

  function handleSelectAll(checked: boolean) {
    checked ? selectAll(filteredIds) : clearSelected()
  }

  function handleDownloadSelected() {
    downloadEpisodes([...selectedIds])
    clearSelected()
  }

  function handleDownloadAll() {
    const ids = filteredEps
      .filter((ep: Episode) => ep.status !== 'done')
      .map((ep: Episode) => ep.id)
    downloadEpisodes(ids)
  }

  function handleDownloadSubsSelected() {
    const ids = [...selectedIds].filter(id => {
      const ep = episodes.find(e => e.id === id)
      return ep && !['queued', 'downloading', 'cancelling'].includes(ep.status)
        && ep.subtitle_status !== 'pending' && !ep.subtitle_langs
    })
    ids.forEach(id => downloadSubsOnly(id))
    clearSelected()
  }

  const selectedSubsCount = [...selectedIds].filter(id => {
    const ep = episodes.find(e => e.id === id)
    return ep && !['queued', 'downloading', 'cancelling'].includes(ep.status)
      && ep.subtitle_status !== 'pending' && !ep.subtitle_langs
  }).length

  // Episode selection categories for Remove / Reset
  const selectedEps = episodes.filter(ep => selectedIds.has(ep.id))
  const notStartedSelected  = selectedEps.filter(ep => ep.status === 'pending')
  const removableSelected   = selectedEps.filter(ep => ['done', 'cancelled', 'failed'].includes(ep.status))
  const resettableSelected  = selectedEps.filter(ep => ['done', 'cancelled', 'failed'].includes(ep.status))

  const canRemove = removableSelected.length > 0
  const canReset  = filter !== 'not_started' && filter !== 'pending' && resettableSelected.length > 0

  function handleRemoveClick() {
    if (notStartedSelected.length > 0) { setPrompt({ kind: 'remove-warn' }); return }
    setPrompt({ kind: 'remove-confirm', deleteFiles: false })
  }

  function handleResetClick() {
    if (notStartedSelected.length > 0) { setPrompt({ kind: 'reset-warn' }); return }
    setPrompt({ kind: 'reset-confirm', deleteFiles: false })
  }

  async function doRemove(deleteFiles: boolean) {
    await removeEpisodes(removableSelected.map(ep => ep.id), deleteFiles)
    setPrompt(null)
  }

  async function doReset(deleteFiles: boolean) {
    await Promise.all(
      resettableSelected.map(ep =>
        resetEpisode(ep.id, { deleteTemp: true, deleteLog: true, deleteFile: deleteFiles })
      )
    )
    clearSelected()
    setPrompt(null)
  }

  return (
    <div className={s.container}>
      {/* ── Show toolbar ── */}
      <div className={s.toolbar}>
        <div className={s.showInfo}>
          <div className={s.showTitle}>{show ? cleanTitle(show.title) : '…'}</div>
          <div className={s.showMeta}>
            {show && (
              <a
                className={s.showSite}
                href={show.url}
                target="_blank"
                rel="noreferrer"
              >
                {siteLabel(show.url)}
              </a>
            )}
            {show && (
              <a
                className={s.imdbLink}
                href={imdbUrl(show.title)}
                target="_blank"
                rel="noreferrer"
              >
                IMDb ↗
              </a>
            )}
          </div>
        </div>

        <div className={s.tabs}>
          {TABS.map(tab => (
            <button
              key={tab.value}
              className={`${s.tab} ${filter === tab.value ? s.active : ''}`}
              onClick={() => handleTabClick(tab.value)}
            >
              <span className={s.tabLabel}>{tab.label}</span>
              <span className={s.tabCount}>({counts[tab.value]})</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Action bar ── */}
      <div className={s.actionBar}>
        <button className={`${s.btn} ${s.btnAccent}`} onClick={handleDownloadAll}>
          <Download size={14} strokeWidth={2.5} /> Download All
        </button>
        <button className={`${s.btn} ${s.btnAccent2}`} onClick={handleDownloadSelected}>
          <Download size={14} strokeWidth={2.5} /> Download Selected
        </button>
        <button
          className={`${s.btn} ${s.btnGhost}`}
          onClick={handleDownloadSubsSelected}
          disabled={selectedSubsCount === 0}
          title={selectedSubsCount === 0 ? 'Select episodes to download subtitles (skip active/already-done)' : `Download subtitles for ${selectedSubsCount} episode${selectedSubsCount === 1 ? '' : 's'}`}
        >
          CC Subs
        </button>
        <div className={s.actionSpacer} />
        <button
          className={`${s.btn} ${s.btnGhost}`}
          disabled={!canRemove}
          onClick={handleRemoveClick}
        >
          Remove Episodes
        </button>
        <button
          className={`${s.btn} ${s.btnGhost}`}
          disabled={!canReset}
          onClick={handleResetClick}
        >
          Reset Selected
        </button>
        <button
          className={`${s.btn} ${rediscovering ? s.btnScanning : s.btnGhost}`}
          disabled={rediscovering}
          onClick={async () => {
            if (!activeShowId) return
            setRediscovering(true)
            try {
              const scrapedAtBefore = show?.scraped_at ?? ''
              await rediscoverEpisodes()
              const poll = setInterval(async () => {
                await loadShows()
                const updated = useStore.getState().shows.find(s => s.id === activeShowId)
                if (updated && updated.scraped_at !== scrapedAtBefore) {
                  clearInterval(poll)
                  await loadEpisodes(activeShowId)
                  setRediscovering(false)
                }
              }, 3000)
            } catch { setRediscovering(false) }
          }}
        >
          {rediscovering ? 'Discovering…' : 'Rediscover Episodes'}
        </button>
        <button
          className={`${s.btn} ${s.btnGhost}`}
          disabled={selectedIds.size === 0}
          onClick={() => { rescanEpisodes([...selectedIds]); clearSelected() }}
        >
          Rescan Sources
        </button>
      </div>

      {/* ── Selection bar ── */}
      <div className={s.selectionBar}>
        <input
          type="checkbox"
          id="select-all"
          checked={allSelected}
          onChange={e => handleSelectAll(e.target.checked)}
        />
        <label className={s.selectionLabel} htmlFor="select-all">
          Select all visible
        </label>
        <button className={s.selectionBtn} onClick={() => selectAll(filteredIds)}>Select all</button>
        <button className={s.selectionBtn} onClick={clearSelected}>Clear</button>
        {!flatView && (<>
          <div className={s.selectionBarDivider} />
          <button className={s.selectionBtn} onClick={expandAll}>Expand all</button>
          <button className={s.selectionBtn} onClick={collapseAll}>Collapse all</button>
        </>)}
        <span className={selectedIds.size > 0 ? s.selectionCountActive : s.selectionCount}>
          {selectedIds.size} selected
        </span>
      </div>

      {/* ── Inline prompt (warnings / confirmations) ── */}
      {prompt && (
        <div className={s.promptBar}>
          {prompt.kind === 'remove-warn' && (<>
            <span className={s.promptText}>
              Not-started episodes cannot be removed — deselect them first.
            </span>
            <button className={s.promptBtn} onClick={() => setPrompt(null)}>Dismiss</button>
          </>)}

          {prompt.kind === 'remove-confirm' && (<>
            <span className={s.promptText}>
              Remove {removableSelected.length} episode{removableSelected.length !== 1 ? 's' : ''}?
            </span>
            <label className={s.promptCheck}>
              <input
                type="checkbox"
                checked={prompt.deleteFiles}
                onChange={e => setPrompt(p => p?.kind === 'remove-confirm' ? { ...p, deleteFiles: e.target.checked } : p)}
              />
              Delete downloaded data
            </label>
            <button className={`${s.promptBtn} ${s.promptBtnDanger}`} onClick={() => doRemove(prompt.deleteFiles)}>
              Remove
            </button>
            <button className={s.promptBtn} onClick={() => setPrompt(null)}>Cancel</button>
          </>)}

          {prompt.kind === 'reset-warn' && (<>
            <span className={s.promptText}>
              Not-started episodes are already pending — deselect them first.
            </span>
            <button className={s.promptBtn} onClick={() => setPrompt(null)}>Dismiss</button>
          </>)}

          {prompt.kind === 'reset-confirm' && (<>
            <span className={s.promptText}>
              Reset {resettableSelected.length} episode{resettableSelected.length !== 1 ? 's' : ''} to pending?
            </span>
            <label className={s.promptCheck}>
              <input
                type="checkbox"
                checked={prompt.deleteFiles}
                onChange={e => setPrompt(p => p?.kind === 'reset-confirm' ? { ...p, deleteFiles: e.target.checked } : p)}
              />
              Delete video files
            </label>
            <button className={s.promptBtn} onClick={() => doReset(prompt.deleteFiles)}>Reset</button>
            <button className={s.promptBtn} onClick={() => setPrompt(null)}>Cancel</button>
          </>)}
        </div>
      )}

      {/* ── Episodes ── */}
      <div className={s.scroll}>
        {filteredIds.length === 0 ? (
          <div className={s.empty}>No episodes match this filter.</div>
        ) : flatView ? (
          filteredIds.map(id => <EpisodeCard key={id} episodeId={id} />)
        ) : (
          Object.entries(seasons)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([season, ids]) => (
              <SeasonGroup
                key={season}
                season={Number(season)}
                episodeIds={ids}
                expanded={expandedSeasons.has(Number(season))}
                onToggle={toggleSeason}
              />
            ))
        )}
      </div>
    </div>
  )
}
