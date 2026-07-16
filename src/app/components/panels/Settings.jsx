import { useCallback, useEffect, useState } from 'react'
import { T, FONT_DATA, FONT_CJK } from '../../theme.js'
import { SectionHeader, Row, Slider, Segmented, ColorSwatch, Toggle } from '../controls.jsx'
import * as timeStore from '../../../state/timeStore.js'

// 時段快捷（docs/ENVIRONMENT_DESIGN.md）：直接寫 timeStore，不經 engine.setParams
// —— 時刻本來就是 timeStore 的地盤，跳時段只是「同一天內 setTime 到目標秒數」，
// 跟 TimelineBar.jsx 的日期切換用同一招（取當下 getTime() 扣掉當日已過秒數）。
const TIME_PRESETS = [
  { label: '清晨 05:30', sec: 5.5 * 3600 },
  { label: '上午 09:00', sec: 9 * 3600 },
  { label: '中午 12:00', sec: 12 * 3600 },
  { label: '下午 15:30', sec: 15.5 * 3600 },
  { label: '黃昏 17:45', sec: 17.75 * 3600 },
  { label: '夜晚 21:00', sec: 21 * 3600 },
]
// Chinese-only option labels (matches the app's other Segmented rows, e.g.
// 精緻度 Detail's 標準/高/超高) — a 3-way bilingual control here left no room
// for the Row's own label (天氣 Weather was ellipsis-truncated to 天...).
const WEATHER_OPTIONS = [
  { label: '晴', value: 'clear' },
  { label: '雨', value: 'rain' },
  { label: '颱風', value: 'typhoon' },
]
const presetBtnStyle = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: FONT_DATA,
  fontSize: T.fs.sm,
  padding: '4px 6px',
  borderRadius: T.radius.md,
  color: T.textDim,
  background: T.ctrlInactiveBg,
  border: `1px solid ${T.ctrlInactiveBorder}`,
  textAlign: 'center',
}

// 設定面板（精選）。rebuild 類參數（demExaggeration / chunkRes）只在放開/點選時
// commit — R1 的教訓：live 送會連環觸發全地形重建。

export default function Settings({ engine }) {
  const [p, setP] = useState(() => ({ ...engine.getParams() }))
  const [walking, setWalking] = useState(false)

  useEffect(() => engine.on('params', () => setP({ ...engine.getParams() })), [engine])
  useEffect(() => engine.on('walk', (s) => setWalking(s.active)), [engine])

  const live = useCallback(
    (key) => (v) => {
      engine.setParams({ [key]: v })
      setP((prev) => ({ ...prev, [key]: v }))
    },
    [engine]
  )
  const commit = useCallback((key) => (v) => engine.setParams({ [key]: v }), [engine])

  return (
    <div>
      <SectionHeader>View</SectionHeader>
      <Slider label="視距 View distance" min={1} max={3.75} step={0.05} value={p.viewRange} onChange={live('viewRange')} format={(v) => `${v.toFixed(2)}×`} />
      <Slider
        label="垂直放大 Vertical scale"
        min={0.5}
        max={5}
        step={0.1}
        value={p.demExaggeration}
        commit={commit('demExaggeration')}
        format={(v) => `${v.toFixed(1)}×`}
      />
      <Row label="品質 Quality">
        <Segmented options={[32, 64, 128]} value={p.chunkRes} onChange={(v) => { engine.setParams({ chunkRes: v }); setP((prev) => ({ ...prev, chunkRes: v })) }} />
      </Row>
      <Row label="精緻度 Detail">
        {/* 標準 = 現況；高 = LOD +1（遠景更銳利）；超高 = +1 且外環滿解析（實驗性，島景重） */}
        <Segmented
          options={['標準', '高', '超高']}
          value={p.detailBias ? (p.outerChunkRes >= 128 ? '超高' : '高') : '標準'}
          onChange={(label) => {
            const patch =
              label === '標準'
                ? { detailBias: 0, outerChunkRes: 64 }
                : label === '高'
                  ? { detailBias: 1, outerChunkRes: 64 }
                  : { detailBias: 1, outerChunkRes: 128 }
            engine.setParams(patch)
            setP((prev) => ({ ...prev, ...patch }))
          }}
        />
      </Row>

      <SectionHeader>Ride view</SectionHeader>
      {/* 車廂視角（src/engine/ride.js，docs/FOLLOW_CAMERA_DESIGN.md §Ride view）——
          rideHeight 是 world unit（1 unit ≈ 480.78m，geo.js K_ANCHOR），這裡只顯示換算後的公尺數；
          rideLookAhead 本身就是公尺，直接顯示 km。兩者都是「讀即用」的 live 參數，不需要 rebuild。 */}
      <Slider
        label="視角高度 Height"
        min={0.01}
        max={0.2}
        step={0.005}
        value={p.rideHeight}
        onChange={live('rideHeight')}
        format={(v) => `${Math.round(v * 480.78)} m`}
      />
      <Slider
        label="前瞻距離 Look-ahead"
        min={500}
        max={8000}
        step={100}
        value={p.rideLookAhead}
        onChange={live('rideLookAhead')}
        format={(v) => `${(v / 1000).toFixed(1)} km`}
      />

      <SectionHeader>Walk 步行</SectionHeader>
      {/* 第一人稱 WASD 步行（src/engine/walk.js, docs/WALK_MODE_DESIGN.md）——
          原型驗證：20m DEM 在步行視角的可接受度。walkSpeed/walkEyeHeight 都是
          「讀即用」的 live 參數，不需要 rebuild，跟上面 Ride view 兩顆滑桿同款。 */}
      <button
        onClick={() => engine.toggleWalkMode()}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          margin: '4px 8px 6px',
          padding: '7px 0',
          width: 'calc(100% - 16px)',
          borderRadius: T.radius.lg,
          textAlign: 'center',
          fontFamily: FONT_CJK,
          fontSize: T.fs.base,
          fontWeight: 600,
          color: walking ? '#fff' : T.textDim,
          background: walking ? T.accent : T.ctrlInactiveBg,
          border: `1px solid ${walking ? T.accent : T.ctrlInactiveBorder}`,
          boxSizing: 'border-box',
        }}
      >
        {walking ? '結束步行 Exit Walk（ESC）' : '進入步行 Enter Walk'}
      </button>
      <Slider
        label="移動速度 Speed"
        min={5}
        max={300}
        step={5}
        value={p.walkSpeed}
        onChange={live('walkSpeed')}
        format={(v) => `${v} m/s`}
      />
      <Slider
        label="視角高度 Eye height"
        min={2}
        max={100}
        step={1}
        value={p.walkEyeHeight}
        onChange={live('walkEyeHeight')}
        format={(v) => `${v} m`}
      />

      <SectionHeader>Peaks</SectionHeader>
      <Slider label="搜尋半徑 Radius" min={0} max={80} step={5} value={p.peakRadiusKm} onChange={live('peakRadiusKm')} format={(v) => v === 0 ? '自動' : `${v} km`} />
      <Slider label="顯示數量 Max peaks" min={3} max={100} step={1} value={p.peakLimit} onChange={live('peakLimit')} format={(v) => String(v)} />
      <Slider label="最低海拔 Min elevation" min={0} max={3000} step={100} value={p.peakMinElev} onChange={live('peakMinElev')} format={(v) => `${v} m`} />

      <SectionHeader>Map</SectionHeader>
      <Slider label="等高線間距 Contour interval" min={0.04} max={0.6} step={0.01} value={p.contourInterval} onChange={live('contourInterval')} format={(v) => v.toFixed(2)} />
      <Slider label="等高線濃度 Contour opacity" min={0} max={1} step={0.02} value={p.contourOpacity} onChange={live('contourOpacity')} format={(v) => v.toFixed(2)} />
      <Slider label="顆粒 Grain" min={0} max={0.5} step={0.01} value={p.grain} onChange={live('grain')} format={(v) => v.toFixed(2)} />
      <Row label="海底地形 Bathymetry">
        <Toggle on={p.bathymetryVisible} onChange={live('bathymetryVisible')} />
      </Row>

      <SectionHeader>Environment</SectionHeader>
      <Row label="即時光影 Auto light">
        <Toggle on={p.envAuto} onChange={live('envAuto')} />
      </Row>
      <Row label="天氣 Weather">
        <Segmented
          options={WEATHER_OPTIONS.map((w) => w.label)}
          value={WEATHER_OPTIONS.find((w) => w.value === p.weather)?.label ?? WEATHER_OPTIONS[0].label}
          onChange={(label) => live('weather')(WEATHER_OPTIONS.find((w) => w.label === label).value)}
        />
      </Row>
      <div style={{ padding: '4px 8px 6px' }}>
        <div style={{ fontFamily: 'inherit', fontSize: T.fs.base, color: T.textMuted, marginBottom: 4 }}>時段 Time of day</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
          {TIME_PRESETS.map((tp) => (
            <button
              key={tp.label}
              style={presetBtnStyle}
              onClick={() => timeStore.setTime(timeStore.getTime() - timeStore.getDaySeconds() + tp.sec)}
            >
              {tp.label}
            </button>
          ))}
        </div>
      </div>

      <SectionHeader>Theme</SectionHeader>
      <Row label="強調色 Accent">
        <ColorSwatch
          value={p.hudAccent}
          onCommit={(v) => {
            engine.setParams({ hudAccent: v }) // rebuilds the 3D FUI layer
            document.documentElement.style.setProperty('--hud-accent', v) // POI tags / kickers
          }}
        />
      </Row>
    </div>
  )
}
