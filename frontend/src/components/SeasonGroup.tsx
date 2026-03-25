import { useStore } from '../store'
import { EpisodeCard } from './EpisodeCard'
import s from './SeasonGroup.module.css'

interface Props {
  season: number
  episodeIds: number[]
  expanded: boolean
  onToggle: (season: number) => void
}

export function SeasonGroup({ season, episodeIds, expanded, onToggle }: Props) {

  const doneCount = useStore(state =>
    episodeIds.filter(id => state.episodes.find(e => e.id === id)?.status === 'done').length
  )

  return (
    <div className={`${s.group} ${!expanded ? s.collapsed : ''}`}>
      <div className={s.header} onClick={() => onToggle(season)}>
        <span className={`${s.toggle} ${!expanded ? s.collapsed : ''}`}>▼</span>
        <span className={s.label}>Season {season}</span>
        <span className={s.count}>{episodeIds.length}</span>
        {doneCount > 0 && (
          <span className={s.doneCount}>{doneCount} done</span>
        )}
      </div>

      {expanded && (
        <div className={s.grid}>
          {episodeIds.map(id => <EpisodeCard key={id} episodeId={id} />)}
        </div>
      )}
    </div>
  )
}
