import GUI from 'lil-gui'
import { DEM_PRESETS } from '../engine/index.js'

// lil-gui debug panel. Binds directly to the engine's live params object so
// .listen() mirrors (lod indicator, autofocus distance) keep working, but every
// side effect goes through engine.setParams / facade methods — this file never
// touches scene internals. hud2 is the sibling UI layer (CSS-variable theming
// and HUD visibility are UI concerns, not engine ones).

export function createDebugPanel(engine, hud2) {
  const params = engine.getParams()
  const set = (key) => (v) => engine.setParams({ [key]: v })

  // dock the panel on the LEFT (below the title block) instead of lil-gui's
  // default top-right auto-placement
  const guiDock = document.createElement('div')
  guiDock.id = 'gui-dock'
  document.body.appendChild(guiDock)
  const gui = new GUI({ title: 'TERRAIN ART / 001', container: guiDock })

  const updateDisplay = () => gui.controllersRecursive().forEach((c) => c.updateDisplay())
  // engine changed params on its own (preset applied, source switched, fly-to)
  engine.on('params', updateDisplay)

  const copyCtrl = gui
    .add(
      {
        async copy() {
          const json = JSON.stringify(engine.getParams(), null, 2)
          try {
            await navigator.clipboard.writeText(json)
          } catch {
            const ta = document.createElement('textarea')
            ta.value = json
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            ta.remove()
          }
          copyCtrl.name('copied ✓')
          setTimeout(() => copyCtrl.name('copy parameters'), 1200)
        },
      },
      'copy'
    )
    .name('copy parameters')

  const fSource = gui.addFolder('Terrain source')
  fSource
    .add(params, 'source', { 'procedural noise': 'noise', 'real world (DEM)': 'real' })
    .name('source')
    .onChange(set('source'))
  const latCtrl = { lat: null, lon: null, zoom: null }
  fSource
    .add(params, 'demLocation', Object.keys(DEM_PRESETS))
    .name('location')
    .onChange(set('demLocation')) // fly-to inside the streamed world (no rebuild)
  latCtrl.lat = fSource.add(params, 'demLat', -85, 85, 0.0001).name('latitude')
  latCtrl.lon = fSource.add(params, 'demLon', -180, 180, 0.0001).name('longitude')
  // P2: zoom is distance-driven — this is a read-only indicator of the current
  // LOD target (params.demZoom mirrors the engine's lodZoom via .listen())
  latCtrl.zoom = fSource.add(params, 'demZoom', [10, 11, 12, 13]).name('lod (auto)').disable().listen()
  fSource.add(params, 'demExaggeration', 0.5, 5, 0.1).name('vertical scale').onFinishChange(set('demExaggeration'))
  fSource.add(params, 'chunkRes', [32, 64, 128]).name('chunk resolution').onFinishChange(set('chunkRes'))
  fSource
    .add({ load: () => engine.flyTo({ lon: params.demLon, lat: params.demLat }) }, 'load')
    .name('load location ⤓')

  const fTerrain = gui.addFolder('Terrain')
  fTerrain.add(params, 'seed', 1, 9999, 1).onFinishChange(set('seed'))
  fTerrain
    .add(
      {
        randomize() {
          engine.setParams({ seed: Math.floor(Math.random() * 9999) + 1 })
          updateDisplay()
        },
      },
      'randomize'
    )
    .name('randomize seed')
  fTerrain.add(params, 'scale', 0.04, 0.4, 0.005).onFinishChange(set('scale'))
  fTerrain.add(params, 'octaves', 2, 8, 1).onFinishChange(set('octaves'))
  fTerrain.add(params, 'lacunarity', 1.6, 3.2, 0.05).onFinishChange(set('lacunarity'))
  fTerrain.add(params, 'gain', 0.3, 0.7, 0.01).onFinishChange(set('gain'))
  fTerrain.add(params, 'amplitude', 0.5, 7, 0.1).onFinishChange(set('amplitude'))
  fTerrain.add(params, 'warp', 0, 6, 0.1).name('domain warp').onFinishChange(set('warp'))
  fTerrain.add(params, 'detail', 0, 0.8, 0.01).name('fine detail').onFinishChange(set('detail'))
  fTerrain.add(params, 'detailScale', 0.5, 6, 0.1).onFinishChange(set('detailScale'))
  fTerrain.add(params, 'resolution', [256, 384, 512, 768, 1024]).onFinishChange(set('resolution'))

  const fSurface = gui.addFolder('Surface material')
  fSurface.addColor(params, 'color').onChange(set('color'))
  fSurface.add(params, 'roughness', 0, 1, 0.01).onFinishChange(set('roughness'))
  fSurface.add(params, 'roughnessVariation', 0, 0.6, 0.01).name('roughness noise').onFinishChange(set('roughnessVariation'))
  fSurface.add(params, 'roughnessScale', 1, 16, 0.5).name('roughness scale').onFinishChange(set('roughnessScale'))
  fSurface.add(params, 'bumpScale', 0, 2, 0.05).name('micro bump').onChange(set('bumpScale'))
  fSurface.add(params, 'envMapIntensity', 0, 1.5, 0.05).name('env reflection').onChange(set('envMapIntensity'))

  const fCamera = gui.addFolder('Camera & focus')
  fCamera.add(params, 'fov', 20, 60, 1).onChange(set('fov'))
  fCamera.add(params, 'autoFocus').name('autofocus cone')
  fCamera.add(params, 'focusDistance', 5, 60, 0.1).name('focus distance').listen()
  fCamera.add(params, 'focusRange', 0.5, 25, 0.1).name('focus range').onChange(set('focusRange'))
  fCamera.add(params, 'bokehScale', 0, 8, 0.1).name('bokeh scale').onChange(set('bokehScale'))

  const fMap = gui.addFolder('Map overlay')
  fMap.add(params, 'mapTint', 0, 1, 0.02).name('hypsometric tint').onChange(set('mapTint'))
  fMap.add(params, 'heightContrast', 0.5, 20, 0.1).name('height contrast').onChange(set('heightContrast'))
  fMap.add(params, 'heightPivot', 0, 1, 0.01).name('height pivot').onChange(set('heightPivot'))
  fMap.addColor(params, 'gradLow').name('gradient: low').onChange(set('gradLow'))
  fMap.addColor(params, 'gradMid1').name('gradient: mid 1').onChange(set('gradMid1'))
  fMap.addColor(params, 'gradMid2').name('gradient: mid 2').onChange(set('gradMid2'))
  fMap.addColor(params, 'gradHigh').name('gradient: high').onChange(set('gradHigh'))
  fMap.add(params, 'gradMid1Pos', 0, 1, 0.01).name('mid 1 position').onChange(set('gradMid1Pos'))
  fMap.add(params, 'gradMid2Pos', 0, 1, 0.01).name('mid 2 position').onChange(set('gradMid2Pos'))
  fMap.add(params, 'bathymetryVisible').name('bathymetry').onChange(set('bathymetryVisible'))
  fMap.addColor(params, 'bathyDeepColor').name('bathy: deep').onChange(set('bathyDeepColor'))
  fMap.addColor(params, 'bathyShallowColor').name('bathy: shallow').onChange(set('bathyShallowColor'))
  fMap.addColor(params, 'bathyCoastColor').name('bathy: coast').onChange(set('bathyCoastColor'))
  fMap.add(params, 'slopeTint', 0, 1, 0.02).name('slope brown').onChange(set('slopeTint'))
  fMap.add(params, 'contourInterval', 0.04, 0.6, 0.01).name('contour interval').onChange(set('contourInterval'))
  fMap.add(params, 'contourOpacity', 0, 1, 0.02).name('contour opacity').onChange(set('contourOpacity'))
  fMap.addColor(params, 'contourColor').name('contour color').onChange(set('contourColor'))
  fMap.add(params, 'gridStep', 2, 14, 0.5).name('grid size').onChange(set('gridStep'))
  fMap.add(params, 'gridOpacity', 0, 1, 0.02).name('grid opacity').onChange(set('gridOpacity'))
  fMap.add(params, 'labels').name('place labels').onChange(set('labels'))
  fMap.add(params, 'coastline').name('coastline').onChange(set('coastline'))
  fMap.add(params, 'coastlineWidth', 0.5, 8, 0.1).name('coastline width').onChange(set('coastlineWidth'))
  fMap.add(params, 'coastlineOpacity', 0, 1, 0.02).name('coastline opacity').onChange(set('coastlineOpacity'))
  fMap.addColor(params, 'coastlineColor').name('coastline color').onChange(set('coastlineColor'))
  fMap.add(params, 'counties').name('county borders').onChange(set('counties'))
  fMap.add(params, 'countiesWidth', 0.5, 6, 0.1).name('county width').onChange(set('countiesWidth'))
  fMap.add(params, 'countiesOpacity', 0, 1, 0.02).name('county opacity').onChange(set('countiesOpacity'))
  fMap.addColor(params, 'countiesColor').name('county color').onChange(set('countiesColor'))

  const fLook = gui.addFolder('Look')
  fLook.add(params, 'exposure', 0.2, 3, 0.02).onChange(set('exposure'))
  fLook.add(params, 'contrast', -0.2, 0.5, 0.01).onChange(set('contrast'))
  fLook.add(params, 'saturation', -1, 0, 0.02).onChange(set('saturation'))
  fLook.add(params, 'vignette', 0, 1, 0.02).onChange(set('vignette'))
  fLook.add(params, 'grain', 0, 0.5, 0.01).onChange(set('grain'))
  fLook.add(params, 'viewRange', 1, 3.75, 0.05).name('view distance').onChange(set('viewRange'))
  fLook.add(params, 'fogNear', 5, 60, 0.5).name('fog start').onChange(set('fogNear'))
  fLook.add(params, 'fogFar', 15, 90, 0.5).name('fog end').onChange(set('fogFar'))
  fLook.addColor(params, 'fogColor').onChange(set('fogColor'))
  fLook.add(params, 'surveyLines').name('survey circles').onChange(set('surveyLines'))

  const fHud = gui.addFolder('HUD')
  fHud.add(params, 'hud').name('show HUD').onChange((v) => {
    engine.setParams({ hud: v })
    hud2.setVisible(v)
  })
  fHud.add(params, 'hudOpacity', 0, 1, 0.02).name('HUD opacity').onChange((v) => {
    engine.setParams({ hudOpacity: v })
    hud2.setOpacity(v)
  })
  fHud.add(params, 'uiBlur', 0, 30, 1).name('panel blur').onChange((v) => {
    engine.setParams({ uiBlur: v })
    hud2.setTheme({ blur: v })
  })
  fHud.add(params, 'uiBgOpacity', 0, 1, 0.02).name('panel bg opacity').onChange((v) => {
    engine.setParams({ uiBgOpacity: v })
    hud2.setTheme({ bgAlpha: v })
  })
  fHud.addColor(params, 'hudAccent').name('accent color').onChange((v) => {
    hud2.setTheme({ accent: v })
    engine.setParams({ hudAccent: v }) // rebuilds the 3D FUI layer
  })
  fHud.addColor(params, 'hudInk').name('ink color').onChange((v) => {
    hud2.setTheme({ ink: v })
    engine.setParams({ hudInk: v })
  })
  fHud.add(params, 'sweepSpeed', 0, 3, 0.05).name('sweep speed')
  fHud.addColor(params, 'scanColor').name('scan color').onChange(set('scanColor'))
  fHud.add(params, 'scanDuration', 1, 8, 0.1).name('scan duration')
  fHud.add(params, 'scanWidth', 0.05, 4, 0.05).name('scan width').onChange(set('scanWidth'))
  fHud.add(params, 'scanBlur', 0, 3, 0.02).name('scan blur').onChange(set('scanBlur'))
  fHud.add(params, 'scanDispHeight', 0, 2, 0.02).name('wave height').onChange(set('scanDispHeight'))
  fHud.add(params, 'scanDispFalloff', 0.1, 6, 0.05).name('wave falloff').onChange(set('scanDispFalloff'))
  fHud.add({ scan: () => engine.triggerScan() }, 'scan').name('trigger scan')

  const fMotion = gui.addFolder('Motion')
  fMotion.add(params, 'coneSpin', 0, 3, 0.05).name('cone spin')
  fMotion.add(params, 'coneTilt', 0, 0.5, 0.01).name('cursor tilt')
  fMotion.add(params, 'coneDrift', 0, 2, 0.05).name('cursor drift')
  fMotion.add(params, 'bob', 0, 0.3, 0.01).name('hover bob')
  fMotion.add(params, 'ringSpeed', 0, 6, 0.1).name('ring speed')
  fMotion.add(params, 'flyDuration', 0.4, 4, 0.1).name('fly duration')
  fMotion.add(params, 'flyEasing', ['smooth', 'glide', 'linear']).name('fly easing')

  const fTour = gui.addFolder('Tour')
  let tourFromCtrl = fTour.add(params, 'tourFrom', engine.getPois().map((p) => p.id)).name('from')
  let tourToCtrl = fTour.add(params, 'tourTo', engine.getPois().map((p) => p.id)).name('to')

  // POI ids change whenever the terrain regenerates (real peak names vs PK-xx) —
  // rebuild both dropdowns and keep them at the top of the folder (the engine
  // already re-pointed params.tourFrom/tourTo at valid ids)
  engine.on('pois', (pois) => {
    const ids = pois.map((p) => p.id)
    tourFromCtrl = tourFromCtrl.options(ids).name('from')
    tourToCtrl = tourToCtrl.options(ids).name('to')
    fTour.$children.prepend(tourToCtrl.domElement)
    fTour.$children.prepend(tourFromCtrl.domElement)
  })
  fTour.add(params, 'tourDuration', 4, 40, 0.5).name('duration (s)')
  fTour.add(params, 'tourAltitude', 0.8, 10, 0.1).name('altitude')
  fTour.add(params, 'tourSmoothing', 0, 1, 0.02).name('path smoothing')
  fTour.add(params, 'tourLook', 0.02, 0.3, 0.01).name('look ahead')
  fTour.add(params, 'tourBank', 0, 3, 0.05).name('bank into turns')
  fTour.add({ start: () => engine.startTour() }, 'start').name('▶ start tour')
  fTour.add({ stop: () => engine.stopTour() }, 'stop').name('■ stop')

  const fPerf = gui.addFolder('Performance')
  fPerf.add(params, 'pixelRatio', 0.5, 2, 0.05).name('render scale').onChange(set('pixelRatio'))
  fPerf.add(params, 'shadowMode', ['dynamic', 'static', 'off']).name('shadows').onChange(set('shadowMode'))
  fPerf.add(params, 'shadowRes', [1024, 2048, 4096]).name('shadow resolution').onChange(set('shadowRes'))
  fMotion.add(params, 'paused')

  const fLight = gui.addFolder('Light')
  fLight.add(params, 'sunIntensity', 0, 16, 0.1).onChange(set('sunIntensity'))
  fLight.add(params, 'sunAzimuth', 0, 360, 1).onChange(set('sunAzimuth'))
  fLight.add(params, 'sunElevation', 5, 85, 1).onChange(set('sunElevation'))
  fLight.add(params, 'hemiIntensity', 0, 2, 0.05).name('ambient').onChange(set('hemiIntensity'))
  fLight.add(params, 'envLight', 0, 1.5, 0.02).name('env light (shadow fill)').onChange(set('envLight'))
  fLight.add(params, 'shadowSoftness', 0, 30, 0.5).name('shadow softness').onChange(set('shadowSoftness'))

  // only Terrain source starts expanded (Tour closed too — the GUI docks on
  // the left and a fully expanded column would cover the bottom-left telemetry)
  fTour.close()
  fTerrain.close()
  fSurface.close()
  fCamera.close()
  fMap.close()
  fLook.close()
  fHud.close()
  fMotion.close()
  fPerf.close()
  fLight.close()

  return { gui }
}
