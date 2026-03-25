import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { EpisodeList } from './components/EpisodeList'
import { ConfigPanel } from './components/ConfigPanel'
import './styles/globals.css'

const layoutStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto 1fr',
  gridTemplateColumns: '300px 1fr',
  gridTemplateAreas: '"topbar topbar" "sidebar main"',
  height: '100vh',
}

export function App() {
  const configOpen = useStore(state => state.configOpen)

  return (
    <div style={layoutStyle}>
      <div style={{ gridArea: 'topbar' }}>
        <TopBar />
      </div>
      <div style={{ gridArea: 'sidebar', overflow: 'hidden', height: '100%' }}>
        <Sidebar />
      </div>
      <main style={{ gridArea: 'main', overflow: 'hidden', height: '100%' }}>
        <EpisodeList />
      </main>
      {configOpen && <ConfigPanel />}
    </div>
  )
}
