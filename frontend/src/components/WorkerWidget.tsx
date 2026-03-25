import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import s from './WorkerWidget.module.css'

interface Props {
  className?: string
}

export function WorkerWidget({ className }: Props) {
  const { workerStatus, setWorkerMaxJobs, restartWorker } = useStore(useShallow(state => ({
    workerStatus:     state.workerStatus,
    setWorkerMaxJobs: state.setWorkerMaxJobs,
    restartWorker:    state.restartWorker,
  })))

  return (
    <div className={`${className ?? ''} ${s.widget}`}>
      <div className={`${s.statusDot} ${workerStatus.running ? s.running : s.stopped}`} />
      <span className={s.label}>
        Workers(<strong>{workerStatus.max_jobs}</strong>)
      </span>
      <div className={s.divider} />
      <button
        className={s.iconBtn}
        onClick={() => setWorkerMaxJobs(workerStatus.max_jobs - 1)}
        disabled={workerStatus.max_jobs <= 1}
        title="Decrease"
      >−</button>
      <button
        className={s.iconBtn}
        onClick={() => setWorkerMaxJobs(workerStatus.max_jobs + 1)}
        disabled={workerStatus.max_jobs >= 10}
        title="Increase"
      >+</button>
      <div className={s.divider} />
      <button
        className={`${s.iconBtn} ${s.restart}`}
        onClick={restartWorker}
        title="Restart worker"
      >↺</button>
    </div>
  )
}
