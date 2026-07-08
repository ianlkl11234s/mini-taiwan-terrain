// White liquid-glass theme — values lifted from mini-taiwan-pulse's LIGHT
// implementation (read-only source of truth, copied by hand):
//   - IconRailSidebar.tsx  LIGHT_PALETTE   (rail/panel chrome, controls)
//   - featureInfo/featureTheme.tsx LIGHT_FEATURE (text ladder, neutral fills)
//   - FeatureInfoPanel.tsx light branch    (panel rgba + blur)
//   - styles/designTokens.ts               (FONT/RADIUS/FONT_SIZE ladders)
// Only the rail background deviates: pulse light rail is solid #FFFFFF; here
// it stays translucent (+ blur) so the terrain reads through — 液態玻璃.

export const FONT_DATA = `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace`
export const FONT_CJK = `"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif`

export const T = {
  // ── SURFACE（白玻璃三階）──────────────────────────────
  railBg: 'rgba(255,255,255,0.82)', // pulse BG_RAIL #FFFFFF, kept glassy
  panelBg: 'rgba(255,255,255,0.92)', // LIGHT_PALETTE.BG_PANEL
  cardBg: 'rgba(255,255,255,0.78)', // read-only info cards (subtler)
  blur: 12, // IconRailSidebar backdropFilter blur(12px)

  // ── BORDER ───────────────────────────────────────────
  border: 'rgba(0,0,0,0.10)', // LIGHT_PALETTE.BORDER / LIGHT_FEATURE.border
  borderStrong: 'rgba(0,0,0,0.22)', // CTRL_ACTIVE_BORDER

  // ── TEXT ladder（LIGHT_FEATURE + LIGHT_PALETTE）───────
  textStrong: '#111827',
  textDefault: '#1F2937',
  textMuted: '#4B5563', // SUB_LABEL
  textDim: '#6B7280', // INACTIVE_TEXT
  textFaint: '#9CA3AF', // DIM

  // ── ACCENT ───────────────────────────────────────────
  // pulse light rail's active-icon "accent" is ink-gray, blue is reserved
  // for links/actions and darkened for white surfaces (featureTheme LIGHT link)
  accentInk: '#374151', // LIGHT_PALETTE.ACCENT (active rail icon)
  accent: '#e8450e', // warm orange — matches HUD accent (#ff4d00) on white glass
  accentSoft: 'rgba(232,69,14,0.10)',
  accentBlue: '#64aaff', // pulse brand accent (shared across themes)

  // ── NEUTRAL fills / control states（LIGHT_PALETTE）────
  bgSubtle: 'rgba(0,0,0,0.04)', // LIGHT_FEATURE.bgSubtle / ROW_HOVER
  bgStrong: 'rgba(0,0,0,0.06)',
  rowActive: 'rgba(0,0,0,0.05)',
  railIconActive: 'rgba(0,0,0,0.07)',
  ctrlActiveBg: 'rgba(0,0,0,0.10)',
  ctrlInactiveBg: 'rgba(0,0,0,0.03)',
  ctrlInactiveBorder: 'rgba(0,0,0,0.12)',
  toggleOff: '#D1D5DB',
  toggleOn: '#1F2937', // ACCENT_TOGGLE
  searchBg: '#F3F4F6',

  // ── shape / type ladders（designTokens.ts）────────────
  radius: { md: 4, lg: 6, xl: 8 },
  fs: { xs: 9, sm: 10, base: 11, md: 12, lg: 13 },
  shadow: '0 8px 32px rgba(0,0,0,0.12)', // light-glass counterpart of ELEVATION.md
}

// pulse IconRailSidebar geometry
export const RAIL_LEFT = 10
export const RAIL_WIDTH = 56
export const PANEL_WIDTH = 288

// shared style fragments
export const glass = (bg = T.panelBg) => ({
  background: bg,
  backdropFilter: `blur(${T.blur}px)`,
  WebkitBackdropFilter: `blur(${T.blur}px)`,
  border: `1px solid ${T.border}`,
  borderRadius: T.radius.xl,
})

export const kickerStyle = {
  fontFamily: FONT_DATA,
  fontSize: T.fs.sm,
  fontWeight: 700,
  letterSpacing: '0.3em',
  color: T.textMuted,
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
}
