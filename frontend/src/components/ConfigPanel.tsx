import { useState, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import s from './ConfigPanel.module.css'

const STORAGE_KEY = 'streamgrabber_config'

interface Config {
  downloadDir: string
  bandwidthLimit: string
  folderPerSeason: boolean
  normalizeTitle: boolean
  sourcePriority: string[]
}

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return {
    downloadDir: '~/Downloads/StreamGrabber',
    bandwidthLimit: '',
    folderPerSeason: true,
    normalizeTitle: false,
    sourcePriority: [],
  }
}

function saveConfig(cfg: Config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

export function ConfigPanel() {
  const setConfigOpen = useStore(state => state.setConfigOpen)

  const discoveredSources = useStore(useShallow(state => {
    const labels = new Set<string>()
    state.episodes.forEach(ep =>
      ep.sources?.forEach(src => labels.add(src.label))
    )
    return Array.from(labels)
  }))

  const saved = loadConfig()
  const [downloadDir, setDownloadDir]         = useState(saved.downloadDir)
  const [bandwidthLimit, setBandwidthLimit]   = useState(saved.bandwidthLimit)
  const [folderPerSeason, setFolderPerSeason] = useState(saved.folderPerSeason)
  const [normalizeTitle, setNormalizeTitle]   = useState(saved.normalizeTitle)
  const [sources, setSources]                 = useState<string[]>(saved.sourcePriority)

  // When discovered sources change, merge any new ones into the saved priority list
  useEffect(() => {
    if (discoveredSources.length === 0) return
    setSources(prev => {
      const existing = new Set(prev)
      const merged = [...prev]
      discoveredSources.forEach(src => { if (!existing.has(src)) merged.push(src) })
      return merged
    })
  }, [discoveredSources.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave() {
    saveConfig({ downloadDir, bandwidthLimit, folderPerSeason, normalizeTitle, sourcePriority: sources })
    setConfigOpen(false)
  }

  function moveSource(index: number, direction: -1 | 1) {
    const next = [...sources]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setSources(next)
  }

  const displaySources = sources.length > 0 ? sources : discoveredSources

  return (
    <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) setConfigOpen(false) }}>
      <div className={s.panel}>
        <div className={s.header}>
          <h2>⚙ Setup</h2>
          <button className={s.closeBtn} onClick={() => setConfigOpen(false)}>✕</button>
        </div>

        <div className={s.body}>

          {/* ── Download settings ── */}
          <div className={s.section}>
            <h3>Downloads</h3>

            <div className={s.field}>
              <label>Download folder</label>
              <input
                className={s.input}
                value={downloadDir}
                onChange={e => setDownloadDir(e.target.value)}
                placeholder="~/Downloads/StreamGrabber"
              />
            </div>

            <div className={s.field}>
              <label>Bandwidth limit</label>
              <div className={s.inputRow}>
                <input
                  className={s.input}
                  value={bandwidthLimit}
                  onChange={e => setBandwidthLimit(e.target.value)}
                  placeholder="0"
                  type="number"
                  min="0"
                />
                <span className={s.inputSuffix}>MB/s (0 = unlimited)</span>
              </div>
            </div>
          </div>

          {/* ── Naming rules ── */}
          <div className={s.section}>
            <h3>Naming Rules</h3>

            <label className={s.toggle}>
              <input
                type="checkbox"
                checked={folderPerSeason}
                onChange={e => setFolderPerSeason(e.target.checked)}
              />
              <span>Create subfolder per season</span>
            </label>
            <div style={{ paddingLeft: 25, marginTop: -6, marginBottom: 10 }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                ShowName/Season 1/S01E01.mp4
              </span>
            </div>

            <label className={s.toggle}>
              <input
                type="checkbox"
                checked={normalizeTitle}
                onChange={e => setNormalizeTitle(e.target.checked)}
              />
              <span>Normalize filenames to lowercase</span>
            </label>
          </div>

          {/* ── Source priority ── */}
          <div className={s.section}>
            <h3>Source Priority</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Sources are tried top to bottom. Per-episode overrides take precedence.
              The list is populated after scraping a show.
            </p>
            {displaySources.length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                No sources discovered yet. Add a show to populate this list.
              </p>
            ) : (
              <div className={s.sourceList}>
                {displaySources.map((src, i) => (
                  <div key={src} className={s.sourceItem}>
                    <span className={s.sourceRank}>{i + 1}</span>
                    <span className={s.sourceName}>{src}</span>
                    <div className={s.sourceArrows}>
                      <button
                        className={s.arrowBtn}
                        onClick={() => moveSource(i, -1)}
                        disabled={i === 0}
                      >▲</button>
                      <button
                        className={s.arrowBtn}
                        onClick={() => moveSource(i, 1)}
                        disabled={i === displaySources.length - 1}
                      >▼</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Worker ── */}
          <div className={s.section}>
            <h3>Worker</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.6 }}>
              Worker concurrency is controlled from the top bar. Additional worker settings will appear here when the worker service is running.
            </p>
          </div>

        </div>

        <div className={s.footer}>
          <button className={s.cancelBtn} onClick={() => setConfigOpen(false)}>Cancel</button>
          <button className={s.saveBtn} onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
