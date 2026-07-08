import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// No StrictMode: its double-invoked effects would boot two WebGL engines.
createRoot(document.getElementById('root')).render(<App />)
