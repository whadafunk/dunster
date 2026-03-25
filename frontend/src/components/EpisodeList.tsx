import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, useTabCounts, useFilteredEpisodeIds } from '../store'
import { SeasonGroup } from './SeasonGroup'
import type { Episode } from '../api/types'
import type { FilterTab } from '../api/types'
import s from './EpisodeList.module.css'

const TABS: { label: string; value: FilterTab }[] = [
  { label: 'All',         value: 'all' },
  { label: 'Not Started', value: 'not_started' },
  { label: 'Pending',     value: 'pending' },
  { label: 'Done',        value: 'done' },
  { label: 'Failed',      value: 'failed' },
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
    downloadEpisodes, loadEpisodes, loadShows, rescanEpisodes, rediscoverEpisodes,
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
    loadEpisodes:        state.loadEpisodes,
    loadShows:           state.loadShows,
    rescanEpisodes:      state.rescanEpisodes,
    rediscoverEpisodes:  state.rediscoverEpisodes,
  })))

  const counts = useTabCounts()
  const filteredIds = useFilteredEpisodeIds(filter)

  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set())
  const [rescanning, setRescanning] = useState(false)
  const [rediscovering, setRediscovering] = useState(false)

  // When episodes load, expand all seasons by default
  useEffect(() => {
    const seasonNums = new Set(episodes.map(e => e.season))
    setExpandedSeasons(seasonNums)
  }, [activeShowId]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSeason(season: number) {
    setExpandedSeasons(prev => {
      const next = new Set(prev)
      next.has(season) ? next.delete(season) : next.add(season)
      return next
    })
  }

  function expandAll() {
    setExpandedSeasons(new Set(Object.keys(seasons).map(Number)))
  }

  function collapseAll() {
    setExpandedSeasons(new Set())
  }

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
  }

  function handleDownloadAll() {
    const ids = filteredEps
      .filter((ep: Episode) => ep.status !== 'done')
      .map((ep: Episode) => ep.id)
    downloadEpisodes(ids)
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
              onClick={() => setFilter(tab.value)}
            >
              <span className={s.tabLabel}>{tab.label}</span>
              <span className={s.tabCount}>({counts[tab.value]})</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Action bar ── */}
      <div className={s.actionBar}>
        <button className={`${s.btn} ${s.btnAccent2}`} onClick={handleDownloadSelected}>
          ↓ Download Selected
        </button>
        <button className={`${s.btn} ${s.btnAccent}`} onClick={handleDownloadAll}>
          ↓ Download All
        </button>
        <div className={s.actionSpacer} />
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
          className={`${s.btn} ${rescanning ? s.btnScanning : s.btnGhost}`}
          disabled={rescanning}
          onClick={async () => {
            if (!activeShowId) return
            setRescanning(true)
            await rescanEpisodes(filteredIds)
            // Poll until sources appear on at least one episode, or 2 min timeout
            const deadline = Date.now() + 120_000
            const poll = setInterval(async () => {
              await loadEpisodes(activeShowId)
              const fresh = useStore.getState().episodes
              const hasSources = fresh.some(ep => ep.sources && ep.sources.length > 0)
              if (hasSources || Date.now() > deadline) {
                clearInterval(poll)
                setRescanning(false)
              }
            }, 3000)
          }}
        >
          {rescanning ? 'Scanning…' : 'Rescan Sources'}
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
        <div className={s.selectionBarDivider} />
        <button className={s.selectionBtn} onClick={expandAll}>Expand all</button>
        <button className={s.selectionBtn} onClick={collapseAll}>Collapse all</button>
        <span className={selectedIds.size > 0 ? s.selectionCountActive : s.selectionCount}>
          {selectedIds.size} selected
        </span>
      </div>

      {/* ── Episodes ── */}
      <div className={s.scroll}>
        {filteredIds.length === 0 ? (
          <div className={s.empty}>No episodes match this filter.</div>
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
