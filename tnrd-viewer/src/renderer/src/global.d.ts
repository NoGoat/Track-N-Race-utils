import type { ViewerApi } from '../../shared/types'

declare global {
  interface Window {
    tnrdViewer: ViewerApi
  }
}

export {}
