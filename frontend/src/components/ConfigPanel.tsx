import { useState, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { api } from '../api/client'
import type { ActiveDownload, DownloadSettings, LogLevel, LogSettings, SubtitleSettings } from '../api/types'
import s from './ConfigPanel.module.css'

const STORAGE_KEY = 'streamgrabber_config'

interface Config {
  downloadDir: string
  normalizeTitle: boolean
  sourcePriority: string[]
}

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const cfg = JSON.parse(raw)
      // Migrate old label-based priority (e.g. "VideoVard (f16px)") to key-based ("f16px")
      if (cfg.sourcePriority?.length) {
        cfg.sourcePriority = cfg.sourcePriority.map((s: string) => {
          const m = s.match(/\(([^)]+)\)$/)
          return m ? m[1] : s
        })
      }
      return cfg
    }
  } catch {}
  return {
    downloadDir: '~/Downloads/StreamGrabber',
    normalizeTitle: false,
    sourcePriority: [],
  }
}

function saveConfig(cfg: Config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

export function ConfigPanel() {
  const { setConfigOpen, restartWorker } = useStore(useShallow(state => ({
    setConfigOpen:  state.setConfigOpen,
    restartWorker:  state.restartWorker,
  })))

  // key → display label (first label seen per key wins)
  const discoveredSourceMap = useStore(useShallow(state => {
    const map = new Map<string, string>()
    state.episodes.forEach(ep =>
      ep.sources?.forEach(src => { if (src.key && !map.has(src.key)) map.set(src.key, src.label) })
    )
    return Object.fromEntries(map)
  }))

  const workerStatus = useStore(state => state.workerStatus)

  const saved = loadConfig()
  const [downloadDir, setDownloadDir]   = useState(saved.downloadDir)
  const [bandwidthLimit, setBandwidthLimit] = useState('')
  const [folderPerShow,   setFolderPerShow]   = useState(false)
  const [folderPerSeason, setFolderPerSeason] = useState(true)
  const [normalizeTitle, setNormalizeTitle]   = useState(saved.normalizeTitle)
  const [sources, setSources]                 = useState<string[]>(saved.sourcePriority)
  const [sourcesModified, setSourcesModified] = useState(false)
  const [maxConcurrent, setMaxConcurrent]         = useState(workerStatus.configured_max_jobs || 2)
  const [maxDownloads, setMaxDownloads]           = useState(workerStatus.configured_max_downloads || 2)
  const [concurrentFragments, setConcurrentFragments] = useState(workerStatus.configured_concurrent_fragments || 3)

  const [showRestartPrompt, setShowRestartPrompt] = useState(false)
  const [restartDownloads, setRestartDownloads]   = useState<ActiveDownload[]>([])

  const [logSettings, setLogSettings]           = useState<LogSettings>({
    log_level_worker: 'normal', log_level_backend: 'normal',
    log_level_download: 'normal', log_level_episode: 'normal',
    log_max_mb_worker: 2, log_max_mb_backend: 2,
    log_max_mb_download: 5, log_max_mb_episode: 1,
  })
  const [initialLogSettings, setInitialLogSettings] = useState<LogSettings | null>(null)

  const [subtitleSettings, setSubtitleSettings]         = useState<SubtitleSettings>({ enabled: false, lang1: 'ro', lang2: '' })
  const [initialSubtitleSettings, setInitialSubtitleSettings] = useState<SubtitleSettings>({ enabled: false, lang1: 'ro', lang2: '' })

  const [initialDownloadSettings, setInitialDownloadSettings] = useState<DownloadSettings | null>(null)

  // Capture all initial values at mount so we can detect changes
  const initialValues = useRef({
    downloadDir,
    bandwidthLimit: '',
    normalizeTitle,
    maxConcurrent,
    maxDownloads,
    concurrentFragments,
  })

  useEffect(() => {
    api.settings.getLogging().then(ls => {
      setLogSettings(ls)
      setInitialLogSettings(ls)
    }).catch(() => {})
    api.settings.getSubtitles().then(ss => {
      setSubtitleSettings(ss)
      setInitialSubtitleSettings(ss)
    }).catch(() => {})
    api.settings.getDownload().then((ds: DownloadSettings) => {
      setFolderPerShow(ds.folder_per_show)
      setFolderPerSeason(ds.folder_per_season)
      const bw = ds.bandwidth_limit > 0 ? String(ds.bandwidth_limit) : ''
      setBandwidthLimit(bw)
      initialValues.current.bandwidthLimit = bw
      setInitialDownloadSettings(ds)
    }).catch(() => {})
  }, [])

  const discoveredKeys = Object.keys(discoveredSourceMap)

  // When discovered sources change, merge any new keys into the saved priority list
  useEffect(() => {
    if (discoveredKeys.length === 0) return
    setSources(prev => {
      const existing = new Set(prev)
      const merged = [...prev]
      discoveredKeys.forEach(key => { if (!existing.has(key)) merged.push(key) })
      return merged
    })
  }, [discoveredKeys.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const iv = initialValues.current
  const bwChanged = bandwidthLimit !== iv.bandwidthLimit
  const folderChanged = initialDownloadSettings !== null && (
    folderPerShow   !== initialDownloadSettings.folder_per_show ||
    folderPerSeason !== initialDownloadSettings.folder_per_season
  )
  const hasChanges =
    downloadDir         !== iv.downloadDir         ||
    bwChanged                                       ||
    normalizeTitle      !== iv.normalizeTitle       ||
    maxConcurrent       !== iv.maxConcurrent        ||
    maxDownloads        !== iv.maxDownloads         ||
    concurrentFragments !== iv.concurrentFragments  ||
    sourcesModified                                 ||
    folderChanged                                   ||
    (initialLogSettings !== null &&
      JSON.stringify(logSettings) !== JSON.stringify(initialLogSettings)) ||
    JSON.stringify(subtitleSettings) !== JSON.stringify(initialSubtitleSettings)

  async function handleSave() {
    saveConfig({ downloadDir, normalizeTitle, sourcePriority: sources })
    await api.worker.setMaxJobs(maxConcurrent).catch(() => {})
    await api.worker.setMaxDownloads(maxDownloads).catch(() => {})
    await api.worker.setConcurrentFragments(concurrentFragments).catch(() => {})
    await api.settings.saveDownload({
      folder_per_show:   folderPerShow,
      folder_per_season: folderPerSeason,
      bandwidth_limit:   parseFloat(bandwidthLimit) || 0,
    }).catch(() => {})
    await api.settings.saveLogging(logSettings).catch(() => {})
    await api.settings.saveSubtitles(subtitleSettings).catch(() => {})

    const needsRestart =
      maxConcurrent !== workerStatus.configured_max_jobs ||
      maxDownloads  !== workerStatus.configured_max_downloads

    if (needsRestart && workerStatus.running) {
      const downloads = await api.worker.activeDownloads().catch(() => [] as ActiveDownload[])
      setRestartDownloads(downloads)
      setShowRestartPrompt(true)
    } else {
      setConfigOpen(false)
    }
  }

  async function handleRestartConfirm(mode: 'graceful' | 'immediate') {
    restartWorker(mode)
    setConfigOpen(false)
  }

  function moveSource(index: number, direction: -1 | 1) {
    const next = [...sources]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setSources(next)
    setSourcesModified(true)
  }

  const displaySources = sourcesModified ? sources : (sources.length > 0 ? sources : discoveredKeys)

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
                <span className={s.inputSuffix}>MB/s total (0 = unlimited)</span>
              </div>
            </div>
          </div>

          {/* ── Naming rules ── */}
          <div className={s.section}>
            <h3>Naming Rules</h3>

            <label className={s.toggle}>
              <input
                type="checkbox"
                checked={folderPerShow}
                onChange={e => {
                  setFolderPerShow(e.target.checked)
                  if (!e.target.checked) setFolderPerSeason(false)
                }}
              />
              <span>Create subfolder per show</span>
            </label>
            <div style={{ paddingLeft: 25, marginTop: -4, marginBottom: 8 }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                Downloads/<em>Show Name</em>/S01E01.mp4
              </span>
            </div>

            <label className={s.toggle} style={{ opacity: folderPerShow ? 1 : 0.4 }}>
              <input
                type="checkbox"
                checked={folderPerSeason}
                disabled={!folderPerShow}
                onChange={e => setFolderPerSeason(e.target.checked)}
              />
              <span>Create subfolder per season</span>
              <span style={{ fontSize: '0.65rem', color: 'var(--muted)', marginLeft: 6, fontFamily: 'JetBrains Mono, monospace' }}>
                (requires subfolder per show)
              </span>
            </label>
            {folderPerShow && folderPerSeason && (
              <div style={{ paddingLeft: 25, marginTop: -4, marginBottom: 8 }}>
                <span style={{ fontSize: '0.68rem', color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                  Downloads/<em>Show Name</em>/Season 1/S01E01.mp4
                </span>
              </div>
            )}

            <label className={s.toggle} style={{ marginTop: 4 }}>
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
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                className={s.sourceActionBtn}
                onClick={() => { setSources(discoveredKeys); setSourcesModified(true) }}
              >
                Get from episodes
              </button>
              <button
                className={s.sourceActionBtn}
                onClick={() => { setSources([]); setSourcesModified(true) }}
              >
                Clear
              </button>
            </div>
            {displaySources.length === 0 ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                No sources discovered yet. Add a show to populate this list.
              </p>
            ) : (
              <div className={s.sourceList}>
                {displaySources.map((key, i) => (
                  <div key={key} className={s.sourceItem}>
                    <span className={s.sourceRank}>{i + 1}</span>
                    <span className={s.sourceName}>{discoveredSourceMap[key] ?? key}</span>
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
            <div className={s.field}>
              <label>Concurrent jobs</label>
              <div className={s.inputRow}>
                <input
                  className={s.input}
                  type="number"
                  min="1"
                  max="10"
                  value={maxConcurrent}
                  onChange={e => setMaxConcurrent(Math.max(1, Math.min(10, Number(e.target.value))))}
                />
                <span className={s.inputSuffix}>max ARQ jobs</span>
              </div>
              <p className={s.hint}>All job types (downloads + scraping). Takes effect after restarting the worker.</p>
            </div>
            <div className={s.field}>
              <label>Concurrent downloads</label>
              <div className={s.inputRow}>
                <input
                  className={s.input}
                  type="number"
                  min="1"
                  max="10"
                  value={maxDownloads}
                  onChange={e => setMaxDownloads(Math.max(1, Math.min(10, Number(e.target.value))))}
                />
                <span className={s.inputSuffix}>max yt-dlp processes</span>
              </div>
              <p className={s.hint}>Max simultaneous yt-dlp downloads. Takes effect after restarting the worker.</p>
            </div>
            <div className={s.field}>
              <label>Parallel HLS segments</label>
              <div className={s.inputRow}>
                <input
                  className={s.input}
                  type="number"
                  min="1"
                  max="4"
                  value={concurrentFragments}
                  onChange={e => setConcurrentFragments(Math.max(1, Math.min(4, Number(e.target.value))))}
                />
                <span className={s.inputSuffix}>segments per download</span>
              </div>
              <p className={s.hint}>Parallel HLS segment downloads per episode (1–4). Takes effect on next download.</p>
            </div>
          </div>

          {/* ── Subtitles ── */}
          <div className={s.section}>
            <h3>Subtitles</h3>

            <label className={s.toggle}>
              <input
                type="checkbox"
                checked={subtitleSettings.enabled}
                onChange={e => setSubtitleSettings(prev => ({ ...prev, enabled: e.target.checked }))}
              />
              <span>Download subtitles if available</span>
            </label>

            {subtitleSettings.enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                <div className={s.field} style={{ marginBottom: 0 }}>
                  <label>Primary language</label>
                  <select
                    className={s.logSelect}
                    style={{ width: '100%' }}
                    value={subtitleSettings.lang1}
                    onChange={e => setSubtitleSettings(prev => ({ ...prev, lang1: e.target.value }))}
                  >
                    <option value="ro">Romanian</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                  </select>
                </div>
                <div className={s.field} style={{ marginBottom: 0 }}>
                  <label>Secondary language</label>
                  <select
                    className={s.logSelect}
                    style={{ width: '100%' }}
                    value={subtitleSettings.lang2}
                    onChange={e => setSubtitleSettings(prev => ({ ...prev, lang2: e.target.value }))}
                  >
                    <option value="">None</option>
                    <option value="ro">Romanian</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                  </select>
                </div>
                <p className={s.hint}>Format: SRT. Auto-generated subtitles are excluded.</p>
              </div>
            )}
          </div>

          {/* ── Logging ── */}
          <div className={s.section}>
            <h3>Logging</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 14, lineHeight: 1.6 }}>
              Logs are written to the <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>logs/</code> folder.
              Changes take effect within ~10 seconds without restart.
            </p>
            <div className={s.logGrid}>
              <span className={s.logGridHeader} />
              <span className={s.logGridHeader}>Level</span>
              <span className={s.logGridHeader}>Max size</span>
              {([
                { key: 'worker',   label: 'Worker log',   defaultMb: 2 },
                { key: 'backend',  label: 'Backend log',  defaultMb: 2 },
                { key: 'download', label: 'Download log', defaultMb: 5 },
                { key: 'episode',  label: 'Episode logs', defaultMb: 1 },
              ] as const).map(({ key, label }) => {
                const levelKey = `log_level_${key}` as keyof LogSettings
                const mbKey    = `log_max_mb_${key}` as keyof LogSettings
                return (
                  <>
                    <span key={`${key}-label`} className={s.logRowLabel}>{label}</span>
                    <select
                      key={`${key}-level`}
                      className={s.logSelect}
                      value={logSettings[levelKey] as LogLevel}
                      onChange={e => setLogSettings(prev => ({ ...prev, [levelKey]: e.target.value }))}
                    >
                      <option value="none">none</option>
                      <option value="normal">normal</option>
                      <option value="debug">debug</option>
                    </select>
                    <div key={`${key}-mb`} className={s.logSizeRow}>
                      <input
                        className={s.logSizeInput}
                        type="number"
                        min="1"
                        max="5"
                        value={logSettings[mbKey] as number}
                        onChange={e => setLogSettings(prev => ({
                          ...prev,
                          [mbKey]: Math.max(1, Math.min(5, Number(e.target.value))),
                        }))}
                      />
                      <span className={s.inputSuffix}>MB</span>
                    </div>
                  </>
                )
              })}
            </div>
          </div>

        </div>

        <div className={s.footer}>
          <button className={s.cancelBtn} onClick={() => setConfigOpen(false)}>Cancel</button>
          <button className={s.saveBtn} onClick={handleSave} disabled={!hasChanges}>Save</button>
        </div>

        {showRestartPrompt && (
          <div className={s.restartOverlay}>
            <div className={s.restartBox}>
              <p className={s.restartTitle}>Settings saved — worker restart required</p>
              <p className={s.restartSub}>
                Concurrent jobs / downloads changes only take effect after a restart.
              </p>
              {restartDownloads.length > 0 && (
                <ul className={s.restartDownloadList}>
                  {restartDownloads.map(d => (
                    <li key={d.id}>
                      <span className={s.restartDownloadShow}>{d.show_title}</span>
                      <span className={s.restartDownloadTitle}>{d.title}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className={s.restartBtns}>
                <div className={s.restartBtnGroup}>
                  <button className={`${s.saveBtn}`} onClick={() => handleRestartConfirm('graceful')}>Graceful</button>
                  <span className={s.restartHint}>Finish current downloads, then restart.</span>
                </div>
                <div className={s.restartBtnGroup}>
                  <button className={`${s.cancelBtn} ${s.dangerBtn}`} onClick={() => handleRestartConfirm('immediate')}>Immediate</button>
                  <span className={s.restartHint}>Kill downloads now and restart.</span>
                </div>
                <button className={s.cancelBtn} onClick={() => setConfigOpen(false)}>Later</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
