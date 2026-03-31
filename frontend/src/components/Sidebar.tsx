import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { Folder, Show } from '../api/types'
import s from './Sidebar.module.css'

function cleanTitle(raw: string): string {
  const yearMatch = raw.match(/^(.+?\(\d{4}\))/)
  if (yearMatch) return yearMatch[1].trim()
  return raw.split(/\s*\|\s*|\s+Online\b/)[0].trim()
}

interface ShowItemProps {
  show: Show
  isActive: boolean
  isSelected: boolean
  isDragging: boolean
  isDropTarget: boolean
  onSelect: () => void
  onToggleCheck: (e: React.MouseEvent) => void
  onQueue: (e: React.MouseEvent) => void
  onArchive: (e: React.MouseEvent) => void
  onRemove: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

function ShowItem({
  show, isActive, isSelected, isDragging, isDropTarget,
  onSelect, onToggleCheck, onQueue, onArchive, onRemove,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: ShowItemProps) {
  const isComplete = show.episode_count > 0 && show.done_count === show.episode_count
  const isActive_ = show.active_count > 0

  return (
    <div
      draggable
      className={[
        s.showItem,
        isActive ? s.active : '',
        isDragging ? s.dragging : '',
        isDropTarget ? s.dropTarget : '',
      ].filter(Boolean).join(' ')}
      onClick={onSelect}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <input
        type="checkbox"
        className={s.showCheckbox}
        checked={isSelected}
        onClick={onToggleCheck}
        onChange={() => {}}
      />
      <div className={s.showIcon}>📺</div>
      <div className={s.showInfo}>
        <div className={s.showTitle}>
          {show.title ? cleanTitle(show.title) : 'Loading…'}
          {isComplete && <span className={s.completeBadge} title="All episodes downloaded">✓</span>}
        </div>
        <div className={s.showMeta}>
          {show.done_count}/{show.episode_count} done
          {isActive_ && <span className={s.activeDot} title="Downloading…" />}
        </div>
      </div>
      <div className={s.showActions}>
        <button className={s.actionBtn} data-tooltip="Queue" onClick={onQueue}>▶</button>
        <button className={s.actionBtn} data-tooltip="Archive" onClick={onArchive}>☐</button>
        <button className={`${s.actionBtn} ${s.removeBtn}`} data-tooltip="Remove" onClick={onRemove}>✕</button>
      </div>
    </div>
  )
}

interface FolderSectionProps {
  folder: Folder
  shows: Show[]
  activeShowId: number | null
  selectedShowIds: Set<number>
  draggedShowId: number | null
  dropTarget: string | null
  onSelectShow: (id: number) => void
  onToggleShow: (e: React.MouseEvent, id: number) => void
  onQueueShow: (e: React.MouseEvent, id: number) => void
  onArchiveShow: (e: React.MouseEvent, id: number) => void
  onRemoveShow: (e: React.MouseEvent, id: number) => void
  onDragStart: (e: React.DragEvent, id: number) => void
  onDragOverShow: (e: React.DragEvent, id: number) => void
  onDropOnShow: (e: React.DragEvent, id: number) => void
  onDragOverFolder: (e: React.DragEvent, folderId: number | null) => void
  onDropOnFolder: (e: React.DragEvent, folderId: number | null) => void
  onDragEnd: () => void
  onDeleteFolder?: () => void
}

function FolderSection({
  folder, shows, activeShowId, selectedShowIds,
  draggedShowId, dropTarget,
  onSelectShow, onToggleShow, onQueueShow, onArchiveShow, onRemoveShow,
  onDragStart, onDragOverShow, onDropOnShow,
  onDragOverFolder, onDropOnFolder, onDragEnd,
  onDeleteFolder,
}: FolderSectionProps) {
  const [collapsed, setCollapsed] = useState(folder.is_system)
  const isFolderDropTarget = dropTarget === `folder-${folder.id}`

  return (
    <div className={s.folderGroup}>
      <div
        className={[s.folderHeader, isFolderDropTarget ? s.folderDropTarget : ''].filter(Boolean).join(' ')}
        onDragOver={e => onDragOverFolder(e, folder.id)}
        onDrop={e => onDropOnFolder(e, folder.id)}
      >
        <button className={s.folderToggle} onClick={() => setCollapsed(c => !c)}>
          {collapsed ? '▶' : '▼'}
        </button>
        <span className={s.folderName}>{folder.name} <span className={s.folderCount}>({shows.length})</span></span>
        {!folder.is_system && onDeleteFolder && (
          <button className={s.folderDeleteBtn} onClick={onDeleteFolder} title="Delete folder">✕</button>
        )}
      </div>
      {!collapsed && (
        <div className={s.folderContent}>
          {shows.map(show => (
            <ShowItem
              key={show.id}
              show={show}
              isActive={show.id === activeShowId}
              isSelected={selectedShowIds.has(show.id)}
              isDragging={draggedShowId === show.id}
              isDropTarget={dropTarget === `show-${show.id}`}
              onSelect={() => onSelectShow(show.id)}
              onToggleCheck={e => onToggleShow(e, show.id)}
              onQueue={e => onQueueShow(e, show.id)}
              onArchive={e => onArchiveShow(e, show.id)}
              onRemove={e => onRemoveShow(e, show.id)}
              onDragStart={e => onDragStart(e, show.id)}
              onDragOver={e => onDragOverShow(e, show.id)}
              onDrop={e => onDropOnShow(e, show.id)}
              onDragEnd={onDragEnd}
            />
          ))}
          {shows.length === 0 && (
            <div className={s.folderEmpty}>Empty</div>
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const {
    shows, folders, activeShowId, selectedShowIds,
    loadShows, loadFolders, addShow, deleteShow, selectShow,
    createFolder, deleteFolder,
    moveShowToFolder, reorderShows, bulkShowAction,
    toggleSelectedShow,
  } = useStore(useShallow(state => ({
    shows:               state.shows,
    folders:             state.folders,
    activeShowId:        state.activeShowId,
    selectedShowIds:     state.selectedShowIds,
    loadShows:           state.loadShows,
    loadFolders:         state.loadFolders,
    addShow:             state.addShow,
    deleteShow:          state.deleteShow,
    selectShow:          state.selectShow,
    createFolder:        state.createFolder,
    deleteFolder:        state.deleteFolder,
    moveShowToFolder:    state.moveShowToFolder,
    reorderShows:        state.reorderShows,
    bulkShowAction:      state.bulkShowAction,
    toggleSelectedShow:  state.toggleSelectedShow,
  })))

  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)

  // DnD state
  const [draggedShowId, setDraggedShowId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  useEffect(() => {
    loadShows()
    loadFolders()
  }, [loadShows, loadFolders])

  // ── URL Add ─────────────────────────────────────────────────────────────────

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

  // ── Folder management ───────────────────────────────────────────────────────

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return
    await createFolder(newFolderName.trim())
    setNewFolderName('')
    setCreatingFolder(false)
  }

  async function handleDeleteFolder(folderId: number) {
    if (!confirm('Delete this folder? Shows will be moved back to the main list.')) return
    await deleteFolder(folderId)
  }

  // ── Show actions ─────────────────────────────────────────────────────────────

  function handleToggleShow(e: React.MouseEvent, showId: number) {
    e.stopPropagation()
    toggleSelectedShow(showId)
  }

  async function handleQueueShow(e: React.MouseEvent, showId: number) {
    e.stopPropagation()
    await bulkShowAction([showId], 'queue')
  }

  async function handleArchiveShow(e: React.MouseEvent, showId: number) {
    e.stopPropagation()
    await bulkShowAction([showId], 'archive')
  }

  async function handleRemoveShow(e: React.MouseEvent, showId: number) {
    e.stopPropagation()
    if (!confirm('Remove this show? Downloads are kept.')) return
    await deleteShow(showId)
  }

  // ── Bulk actions ─────────────────────────────────────────────────────────────

  async function handleBulkAction(action: 'archive' | 'remove' | 'queue') {
    if (action === 'remove') {
      if (!confirm(`Remove ${selectedShowIds.size} show(s)? Downloads are kept.`)) return
    }
    await bulkShowAction([...selectedShowIds], action)
  }

  // ── Drag and drop ────────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, showId: number) {
    setDraggedShowId(showId)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragEnd() {
    setDraggedShowId(null)
    setDropTarget(null)
  }

  function handleDragOverShow(e: React.DragEvent, showId: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(`show-${showId}`)
  }

  function handleDragOverFolder(e: React.DragEvent, folderId: number | null) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(folderId === null ? 'ungrouped' : `folder-${folderId}`)
  }

  async function handleDropOnShow(e: React.DragEvent, targetShowId: number) {
    e.preventDefault()
    if (!draggedShowId || draggedShowId === targetShowId) {
      handleDragEnd()
      return
    }
    const draggedShow = shows.find(s => s.id === draggedShowId)
    const targetShow = shows.find(s => s.id === targetShowId)
    if (!draggedShow || !targetShow) { handleDragEnd(); return }

    if (draggedShow.folder_id !== targetShow.folder_id) {
      // Different group: just move to target's folder
      await moveShowToFolder(draggedShowId, targetShow.folder_id)
    } else {
      // Same group: reorder (insert dragged before target)
      const groupShows = shows
        .filter(s => s.folder_id === targetShow.folder_id)
        .sort((a, b) => a.sort_order - b.sort_order)
      const withoutDragged = groupShows.filter(s => s.id !== draggedShowId)
      const targetIndex = withoutDragged.findIndex(s => s.id === targetShowId)
      const newOrder = [
        ...withoutDragged.slice(0, targetIndex),
        draggedShow,
        ...withoutDragged.slice(targetIndex),
      ]
      await reorderShows(newOrder.map((s, idx) => ({ id: s.id, sort_order: idx })))
    }
    handleDragEnd()
  }

  async function handleDropOnFolder(e: React.DragEvent, folderId: number | null) {
    e.preventDefault()
    if (draggedShowId !== null) {
      await moveShowToFolder(draggedShowId, folderId)
    }
    handleDragEnd()
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const archivedFolder = folders.find(f => f.is_system) ?? null
  const userFolders = folders.filter(f => !f.is_system)
  const ungroupedShows = shows.filter(s => s.folder_id === null)

  function getFolderShows(folderId: number): Show[] {
    return shows.filter(s => s.folder_id === folderId)
  }

  const hasSelection = selectedShowIds.size > 0

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <aside className={s.sidebar}>
      <div className={s.sidebarHeader}>
        <div className={s.headerTop}>
          <h2>Shows</h2>
          <button
            className={s.newFolderBtn}
            onClick={() => setCreatingFolder(c => !c)}
            title="Create new folder"
          >
            + Folder
          </button>
        </div>

        {creatingFolder && (
          <div className={s.newFolderForm}>
            <input
              autoFocus
              type="text"
              placeholder="Folder name…"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreateFolder()
                if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName('') }
              }}
              className={s.newFolderInput}
            />
            <button className={s.addBtn} onClick={handleCreateFolder}>Add</button>
          </div>
        )}

        <div className={s.addForm}>
          <input
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

        <div className={s.bulkActions}>
          <button className={s.bulkBtn} disabled={!hasSelection} onClick={() => handleBulkAction('queue')} title="Queue not-started episodes">Queue</button>
          <button className={s.bulkBtn} disabled={!hasSelection} onClick={() => handleBulkAction('archive')} title="Move to Archived">Archive</button>
          <button className={`${s.bulkBtn} ${s.bulkRemove}`} disabled={!hasSelection} onClick={() => handleBulkAction('remove')} title="Remove shows">Remove</button>
          {hasSelection && <span className={s.bulkCount}>{selectedShowIds.size} selected</span>}
        </div>
      </div>

      <div className={s.showsList}>
        {shows.length === 0 ? (
          <div className={s.empty}>
            📺<br />No shows yet.<br />Paste a show URL above.
          </div>
        ) : (
          <>
            {/* Archived folder — always at top */}
            {archivedFolder && (
              <FolderSection
                folder={archivedFolder}
                shows={getFolderShows(archivedFolder.id)}
                activeShowId={activeShowId}
                selectedShowIds={selectedShowIds}
                draggedShowId={draggedShowId}
                dropTarget={dropTarget}
                onSelectShow={selectShow}
                onToggleShow={handleToggleShow}
                onQueueShow={handleQueueShow}
                onArchiveShow={handleArchiveShow}
                onRemoveShow={handleRemoveShow}
                onDragStart={handleDragStart}
                onDragOverShow={handleDragOverShow}
                onDropOnShow={handleDropOnShow}
                onDragOverFolder={handleDragOverFolder}
                onDropOnFolder={handleDropOnFolder}
                onDragEnd={handleDragEnd}
              />
            )}

            {/* User-created folders */}
            {userFolders.map(folder => (
              <FolderSection
                key={folder.id}
                folder={folder}
                shows={getFolderShows(folder.id)}
                activeShowId={activeShowId}
                selectedShowIds={selectedShowIds}
                draggedShowId={draggedShowId}
                dropTarget={dropTarget}
                onSelectShow={selectShow}
                onToggleShow={handleToggleShow}
                onQueueShow={handleQueueShow}
                onArchiveShow={handleArchiveShow}
                onRemoveShow={handleRemoveShow}
                onDragStart={handleDragStart}
                onDragOverShow={handleDragOverShow}
                onDropOnShow={handleDropOnShow}
                onDragOverFolder={handleDragOverFolder}
                onDropOnFolder={handleDropOnFolder}
                onDragEnd={handleDragEnd}
                onDeleteFolder={() => handleDeleteFolder(folder.id)}
              />
            ))}

            {/* Ungrouped shows */}
            <div
              className={[s.ungrouped, dropTarget === 'ungrouped' ? s.ungroupedDropTarget : ''].filter(Boolean).join(' ')}
              onDragOver={e => handleDragOverFolder(e, null)}
              onDrop={e => handleDropOnFolder(e, null)}
            >
              {ungroupedShows.map(show => (
                <ShowItem
                  key={show.id}
                  show={show}
                  isActive={show.id === activeShowId}
                  isSelected={selectedShowIds.has(show.id)}
                  isDragging={draggedShowId === show.id}
                  isDropTarget={dropTarget === `show-${show.id}`}
                  onSelect={() => selectShow(show.id)}
                  onToggleCheck={e => handleToggleShow(e, show.id)}
                  onQueue={e => handleQueueShow(e, show.id)}
                  onArchive={e => handleArchiveShow(e, show.id)}
                  onRemove={e => handleRemoveShow(e, show.id)}
                  onDragStart={e => handleDragStart(e, show.id)}
                  onDragOver={e => handleDragOverShow(e, show.id)}
                  onDrop={e => handleDropOnShow(e, show.id)}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
