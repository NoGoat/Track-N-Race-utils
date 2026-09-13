import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import PageSwitcher from './PageSwitcher'
import RamViewer from './pages/ram/App'
import TnrdViewer from './pages/tnrd/App'
import darkIcon from './pages/tnrd/assets/icon_transparent.png'
import lightIcon from './pages/tnrd/assets/icon_transparent_light.png'
import type { Theme, ToolPage } from './types'

const themes: Theme[] = ['dark', 'midnight', 'light']

function savedPage(): ToolPage {
  return localStorage.getItem('track-n-race-dev-tools-page') === 'ram' ? 'ram' : 'tnrd'
}

function savedTheme(): Theme {
  const stored = localStorage.getItem('track-n-race-dev-tools-theme')
  if (stored && themes.includes(stored as Theme)) return stored as Theme
  const legacy = localStorage.getItem(savedPage() === 'ram' ? 'ram-usage-viewer-theme' : 'tnrd-viewer-theme')
  return legacy && themes.includes(legacy as Theme) ? legacy as Theme : 'dark'
}

export default function App() {
  const [page, setPage] = useState<ToolPage>(savedPage)
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [maximized, setMaximized] = useState(false)
  const [fileNames, setFileNames] = useState<Record<ToolPage, string | null>>({ tnrd: null, ram: null })
  const [openRequests, setOpenRequests] = useState<Record<ToolPage, number>>({ tnrd: 0, ram: 0 })

  const setTnrdFileName = useCallback((name: string | null) => {
    setFileNames(current => current.tnrd === name ? current : { ...current, tnrd: name })
  }, [])
  const setRamFileName = useCallback((name: string | null) => {
    setFileNames(current => current.ram === name ? current : { ...current, ram: name })
  }, [])
  const requestOpen = useCallback(() => {
    setOpenRequests(current => ({ ...current, [page]: current[page] + 1 }))
  }, [page])

  useEffect(() => {
    localStorage.setItem('track-n-race-dev-tools-page', page)
  }, [page])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('track-n-race-dev-tools-theme', theme)
  }, [theme])

  useEffect(() => window.devTools.onActivatePage(setPage), [])

  useEffect(() => window.tnrdViewer.onMaximized(setMaximized), [])

  useEffect(() => {
    const fileName = fileNames[page]
    const toolName = page === 'tnrd' ? 'TNRD Viewer' : 'RAM Usage Viewer'
    document.title = fileName ? `${fileName} · ${toolName}` : `Track N Race · ${toolName}`
  }, [fileNames, page])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key.toLocaleLowerCase() !== 'o') return
      event.preventDefault()
      requestOpen()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [requestOpen])

  const fileName = fileNames[page] ?? (page === 'tnrd' ? 'No recording open' : 'No RAM usage log open')
  const openTitle = page === 'tnrd' ? 'Open recording (Ctrl+O)' : 'Open RAM usage log (Ctrl+O)'

  return (
    <div className="dev-tools-shell">
      <header className="titlebar shared-titlebar" onDoubleClick={event => { if (!(event.target as HTMLElement).closest('.no-drag')) window.tnrdViewer.maximize() }}>
        <div className="brand">
          <img className="brand-mark" src={theme === 'light' ? lightIcon : darkIcon} alt="" />
          <span className="brand-name">Track N Race</span>
          <span className="brand-divider" />
          <PageSwitcher value={page} onChange={setPage} isDark={theme !== 'light'} />
        </div>
        <span className="title-file">{fileName}</span>
        <div className="title-actions no-drag">
          <button className="icon-button" title={openTitle} onClick={requestOpen} aria-label={openTitle}><svg viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.3 1.5h6.7v7.5h-13zM1.5 4.5V2.8h4.4l1.2 1.7" /></svg></button>
          <button className="icon-button" title="Change theme" onClick={() => setTheme(value => themes[(themes.indexOf(value) + 1) % themes.length])} aria-label="Change theme"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2" /><path d="M8 1v1.4M8 13.6V15M1 8h1.4M13.6 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" /></svg></button>
          <span className="window-divider" />
          <button className="window-button" onClick={() => window.tnrdViewer.minimize()} aria-label="Minimize"><svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg></button>
          <button className="window-button" onClick={() => window.tnrdViewer.maximize()} aria-label="Maximize"><svg viewBox="0 0 10 10">{maximized ? <path d="M3 .5h6.5V7M.5 3h6.5v6.5H.5z" /> : <rect x=".5" y=".5" width="9" height="9" />}</svg></button>
          <button className="window-button close-button" onClick={() => window.tnrdViewer.close()} aria-label="Close"><svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" /></svg></button>
        </div>
      </header>

      <div className="tool-pages">
        <div className={`page-host ${page === 'tnrd' ? 'active' : ''}`} aria-hidden={page !== 'tnrd'}>
          <TnrdViewer active={page === 'tnrd'} theme={theme} openRequest={openRequests.tnrd} onFileNameChange={setTnrdFileName} />
        </div>
        <div className={`page-host ram-page ${page === 'ram' ? 'active' : ''}`} aria-hidden={page !== 'ram'}>
          <RamViewer active={page === 'ram'} theme={theme} openRequest={openRequests.ram} onFileNameChange={setRamFileName} />
        </div>
      </div>
    </div>
  )
}
