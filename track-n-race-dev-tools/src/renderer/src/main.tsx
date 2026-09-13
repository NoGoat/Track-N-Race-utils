import { createRoot } from 'react-dom/client'
import 'uplot/dist/uPlot.min.css'
import './pages/tnrd/styles.css'
import './pages/ram/styles.css'
import './styles.css'
import App from './App'

createRoot(document.getElementById('root')!).render(<App />)
