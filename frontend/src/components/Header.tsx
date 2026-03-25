import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import s from './Header.module.css'

export function Header() {
  const { globalStatus, loadGlobalStatus } = useStore(useShallow(state => ({
    globalStatus: state.globalStatus,
    loadGlobalStatus: state.loadGlobalStatus,
  })))

  useEffect(() => {
    loadGlobalStatus()
    const interval = setInterval(loadGlobalStatus, 5000)
    return () => clearInterval(interval)
  }, [loadGlobalStatus])

  return (
    <header className={s.header}>
      <div className={s.logo}>Stream<span>Grabber</span></div>
      <div className={s.stats}>
        <span className={`${s.stat} ${s.done}`}><strong>{globalStatus.done}</strong> done</span>
        <span className={`${s.stat} ${s.dl}`}><strong>{globalStatus.downloading}</strong> downloading</span>
        <span className={`${s.stat} ${s.fail}`}><strong>{globalStatus.failed}</strong> failed</span>
        <span className={s.stat}><strong>{globalStatus.total}</strong> total</span>
      </div>
    </header>
  )
}
