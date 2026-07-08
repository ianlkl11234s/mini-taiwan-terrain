// Screen-space FUI layer: sector data block, telemetry, cone tracking reticle,
// POI markers with leader lines, and a selection panel. Pure DOM — all world →
// screen projection happens engine-side; frame() receives ready screen-space
// coordinates (the engine's 'frame' event). This is the layer the React shell
// (R2) will replace.

const el = (cls, html = '') => {
  const d = document.createElement('div')
  d.className = cls
  d.innerHTML = html
  return d
}

export function createHud2D({ onSelectPoi, onDeselect, onScan }) {
  const root = el('hud')
  document.body.appendChild(root)

  // ---- static frame: corner brackets
  root.appendChild(el('hud-corner tl'))
  root.appendChild(el('hud-corner tr'))
  root.appendChild(el('hud-corner bl'))
  root.appendChild(el('hud-corner br'))

  // ---- top-left sector block
  const sector = el(
    'hud-block hud-tl',
    `<div class="hud-kicker"><span class="sq"></span>SECTOR</div>
     <div class="hud-dim" data-t="sectorId">SECTOR ID: —</div>
     <div class="hud-rule"></div>
     <div class="hud-strong">PROCEDURAL RANGE</div>
     <div class="hud-dim" data-t="gps">GPS: —</div>
     <div class="hud-dim" data-t="meta">—</div>`
  )
  root.appendChild(sector)

  // ---- bottom-right telemetry block
  const telem = el(
    'hud-block hud-brt',
    `<div class="hud-kicker"><span class="sq"></span>TELEMETRY</div>
     <div class="hud-row"><span>CAM AZ</span><b data-t="az">—</b></div>
     <div class="hud-row"><span>CAM EL</span><b data-t="el">—</b></div>
     <div class="hud-row"><span>FOCUS</span><b data-t="focus">—</b></div>
     <div class="hud-row"><span>LOD</span><b data-t="lod">—</b></div>
     <div class="hud-row"><span>FPS</span><b data-t="fps">—</b></div>
     <div class="hud-row"><span>T+</span><b data-t="clock">—</b></div>`
  )
  root.appendChild(telem)

  // ---- cone tracking reticle
  const reticle = el(
    'hud-reticle',
    `<span class="rb tl"></span><span class="rb tr"></span><span class="rb bl"></span><span class="rb br"></span>
     <div class="hud-ret-label">
       <div class="hud-ret-name">MONOLITH-01 <i>▸ TRACKING</i></div>
       <div class="hud-ret-sub"><span data-t="alt">ALT —</span> · <span data-t="spin">SPIN —</span></div>
     </div>`
  )
  root.appendChild(reticle)
  reticle.querySelector('.hud-ret-label').addEventListener('click', () => onScan?.())

  // ---- selection panel (anchored below the clicked marker)
  const panel = el(
    'hud-panel',
    `<div class="hud-panel-head"><span class="sq"></span><b data-t="pName">—</b><button class="hud-x" title="close &amp; reset view">✕</button></div>
     <div class="hud-row"><span>CLASS</span><b data-t="pKind">—</b></div>
     <div class="hud-row"><span>ELEV</span><b data-t="pElev">—</b></div>
     <div class="hud-row"><span>GRID</span><b data-t="pGrid">—</b></div>
     <div class="hud-row"><span>STATUS</span><b class="accent">LOCKED</b></div>`
  )
  panel.style.display = 'none'
  root.appendChild(panel)
  panel.querySelector('.hud-x').addEventListener('click', () => onDeselect?.())

  const q = (parent, key) => parent.querySelector(`[data-t="${key}"]`)

  // ---- POI markers
  let poiEls = []
  let selected = -1

  function setPois(pois) {
    poiEls.forEach((p) => p.remove())
    poiEls = pois.map((p, i) => {
      const m = el(
        'hud-poi',
        `<span class="tag"><b>${p.id}</b><i>${p.kind} · ${p.feet.toLocaleString()} FT</i></span>`
      )
      m.addEventListener('click', () => onSelectPoi?.(i))
      root.appendChild(m)
      return m
    })
  }

  let acc = 0
  let reticleOn = true

  return {
    root,
    setPois,
    setStatic(p) {
      const real = p.source === 'real'
      q(sector, 'sectorId').textContent = `SECTOR ID: 465-NKJ-${String(p.seed).padStart(4, '0')}K`
      sector.querySelector('.hud-strong').textContent = real ? p.demLocation.toUpperCase() : 'PROCEDURAL RANGE'
      q(sector, 'gps').textContent = real
        ? `GPS: ${p.demLat.toFixed(4)}, ${p.demLon.toFixed(4)} · Z${p.demZoom}`
        : 'GPS: 46.4076, 11.8524 · GRID 56×56'
      q(sector, 'meta').textContent = real
        ? 'ELEV: NLSC 20M DTM (2024)'
        : `SEED ${String(p.seed).padStart(4, '0')} · MESH ${p.resolution}²`
    },
    // live GPS readout while panning (real mode) — the rest of the sector
    // block keeps the loaded-center name from setStatic()
    setGps(lat, lon, zoom) {
      q(sector, 'gps').textContent = `GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)} · Z${zoom}`
    },
    setSelected(i, poi) {
      selected = i
      poiEls.forEach((m, j) => m.classList.toggle('active', j === i))
      if (i >= 0 && poi) {
        q(panel, 'pName').textContent = poi.id
        q(panel, 'pKind').textContent = poi.kind
        q(panel, 'pElev').textContent = `${poi.feet.toLocaleString()} FT`
        q(panel, 'pGrid').textContent = poi.grid
        panel.style.display = 'block'
      } else {
        panel.style.display = 'none'
      }
    },
    // engine 'frame' event payload: screen-space anchors + telemetry numbers
    frame(data) {
      // anchored: reticle on the cone
      if (reticleOn) {
        reticle.style.transform = `translate(${data.reticle.x.toFixed(1)}px, ${data.reticle.y.toFixed(1)}px)`
        reticle.style.opacity = data.reticle.visible ? 1 : 0
      }

      // anchored: POI markers
      data.poiScreens.forEach((pos, i) => {
        const m = poiEls[i]
        if (!m) return
        m.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`
        m.style.opacity = pos.visible ? 1 : 0
      })

      // anchored: selection panel follows its marker, just below the tag
      if (selected >= 0 && data.poiScreens[selected]) {
        const pos = data.poiScreens[selected]
        const px = Math.min(Math.max(pos.x + 14, 10), window.innerWidth - 270)
        const py = Math.min(pos.y + 16, window.innerHeight - 190)
        panel.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
        panel.style.opacity = pos.visible ? 1 : 0
      }

      // throttled text refresh
      acc += data.dt
      if (acc > 0.15) {
        acc = 0
        q(telem, 'az').textContent = `${data.az.toFixed(1)}°`
        q(telem, 'el').textContent = `${data.el.toFixed(1)}°`
        q(telem, 'focus').textContent = data.focus.toFixed(2)
        q(telem, 'lod').textContent = data.lod ? `Z${data.lod}` : '—'
        q(telem, 'fps').textContent = String(Math.round(data.fps))
        q(telem, 'clock').textContent = data.clock
        q(reticle, 'alt').textContent = `ALT ${data.coneAlt.toFixed(2)}`
        q(reticle, 'spin').textContent = `SPIN ${data.spin.toFixed(2)}`
      }
    },
    setVisible(vis) {
      root.style.display = vis ? 'block' : 'none'
    },
    setReticleVisible(vis) {
      reticleOn = vis
      reticle.style.display = vis ? '' : 'none'
    },
    setOpacity(o) {
      root.style.opacity = o
    },
    // HUD theming lives in CSS custom properties (shared with the gui dock)
    setTheme({ accent, ink, blur, bgAlpha } = {}) {
      const s = document.documentElement.style
      if (accent !== undefined) s.setProperty('--hud-accent', accent)
      if (ink !== undefined) s.setProperty('--hud-ink', ink)
      if (blur !== undefined) s.setProperty('--hud-blur', `${blur}px`)
      if (bgAlpha !== undefined) s.setProperty('--hud-bg-alpha', bgAlpha)
    },
  }
}
