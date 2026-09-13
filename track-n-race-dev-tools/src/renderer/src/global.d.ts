import type { ViewerApi } from '../../shared/tnrdTypes'
import type { RamViewerApi } from '../../shared/ramTypes'

declare global {
  interface Window {
    tnrdViewer: ViewerApi
    ramViewer: RamViewerApi
    devTools: {
      onActivatePage(callback: (page: 'tnrd' | 'ram') => void): () => void
    }
  }
}

export {}
