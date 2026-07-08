import { createEngine } from './engine/index.js'
import { createHud2D } from './ui/hud2d.js'
import { createDebugPanel } from './ui/debugPanel.js'

// Bootstrap: build the engine, build the two UI layers (FUI HUD + lil-gui
// debug panel), wire engine events → DOM. All 3D/terrain logic lives behind
// the engine facade — swapping this UI for a React shell (R2) touches nothing
// inside src/engine/.

async function main() {
  const engine = await createEngine({ container: document.getElementById('app') })
  const params = engine.getParams()

  // ---- loading indicator
  const loadingEl = document.getElementById('loading')
  engine.on('loading', ({ active, message }) => {
    if (message) loadingEl.textContent = message
    loadingEl.classList.toggle('hidden', !active)
  })

  // ---- screen-space FUI HUD
  const hud2 = createHud2D({
    onSelectPoi: (i) => engine.selectPoi(i),
    onDeselect: () => engine.deselect(),
    onScan: () => engine.triggerScan({ kick: true }),
  })
  hud2.setTheme({ accent: params.hudAccent, ink: params.hudInk, blur: params.uiBlur, bgAlpha: params.uiBgOpacity })
  hud2.setPois(engine.getPois())
  hud2.setStatic(params)
  hud2.setVisible(params.hud)
  hud2.setOpacity(params.hudOpacity)
  hud2.setReticleVisible(params.source !== 'real')

  engine.on('pois', (pois) => {
    hud2.setPois(pois)
    hud2.setStatic(params)
    hud2.setReticleVisible(params.source !== 'real')
  })
  engine.on('selection', ({ index, poi }) => hud2.setSelected(index, poi))
  engine.on('gps', ({ lat, lon, zoom }) => hud2.setGps(lat, lon, zoom))
  engine.on('frame', (f) => hud2.frame(f))
  engine.on('params', () => hud2.setStatic(params))

  // ---- debug panel (lil-gui)
  createDebugPanel(engine, hud2)

  // console access for debugging/scripting — engine facade + the legacy
  // internals the verify scripts rely on
  window.__exp = engine.debug
}

main()
