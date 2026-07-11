// External Time Store — lazy-clock variant (docs/TIMELINE_DESIGN.md, opus
// 審定版). Framework-agnostic module state (NOT React state): time is never
// advanced by a running loop, it is recomputed on demand from a (baseTime,
// baseAnchor) pair anchored at the last discrete change (seek/play/pause/
// setSpeed). This is what lets terrain-art's on-demand render rule survive a
// timeline — no RAF, no setInterval driving WebGL, ever. Import direction:
// this module imports nothing (see design §1.5); engine/ and app/ import it,
// never the other way around.
//
// Consumers:
//   - src/engine/index.js   isAnimating() gate + subscribe(invalidate)
//   - src/engine/trains.js  getDaySeconds() read fresh every tickView
//   - src/app/components/TimelineBar.jsx  epoch-snapshot React binding
//
// Three subscription grains (design §1.3):
//   subscribe(cb)             fires synchronously on every discrete change
//                             (seek/play/pause/setSpeed) — used by the engine
//                             to invalidate() and reopen the render window.
//   subscribeThrottled(ms,cb) fires on discrete change (respecting its own ms)
//                             AND periodically while playing, driven by the
//                             internal 250ms notifier below — used by the UI
//                             clock/scrubber.
//   subscribeDate(cb)        fires when the derived Asia/Taipei dateKey
//                             changes, 300ms leading+trailing debounce (mirrors
//                             mini-taiwan-pulse's dateNotifier.ts) — no
//                             consumer yet, wired for future time-aware layers
//                             (rain/water level).
//
// notify-pass ordering (design §5 trap #2): epoch is bumped BEFORE any
// callback runs, on every pass (discrete or notifier tick) — React's
// useSyncExternalStore snapshots getEpoch(), and if epoch lagged the
// callback the clock would appear frozen (stale snapshot === same value).

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000 // Asia/Taipei = UTC+8, no DST — single definition source (was duplicated in trains.js)

// ---------------------------------------------------------------- core clock state
let baseTime = Date.now() / 1000 // unix seconds, anchored at the last discrete change
let baseAnchor = performance.now() // monotonic clock (ms) at that anchor
let playing = true
let speed = 1
// live: whether the clock should keep gluing itself to the real wall clock
// (design §1.6) — true only in the "default, untouched" state and right
// after goNow(); any seek/pause/non-1x speed turns it off so a user who time-
// travelled to the past is never silently pulled back to "now".
let live = true
let epoch = 0 // monotonic change counter — the ONLY safe useSyncExternalStore snapshot (design §5 trap #1)

// time is always recomputed, never advanced by a loop — any consumer at any
// moment gets the correct value with zero dependence on a tick surviving.
export function getTime() {
  if (!playing) return baseTime
  return baseTime + ((performance.now() - baseAnchor) / 1000) * speed
}

// ---------------------------------------------------------------- Asia/Taipei derivation
// Built from a UTC-shifted Date's own UTC getters (no Intl timezone
// formatting) — same technique trains.js used to use inline; now the single
// definition source per design §2.3.
function shiftedTaipeiDate(t) {
  return new Date(t * 1000 + TAIPEI_OFFSET_MS)
}

function computeDateKey(t) {
  const d = shiftedTaipeiDate(t)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function computeDaySeconds(t) {
  const d = shiftedTaipeiDate(t)
  const raw = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + d.getUTCMilliseconds() / 1000
  return ((raw % 86400) + 86400) % 86400
}

export function getDateKey() {
  return computeDateKey(getTime())
}

export function getDaySeconds() {
  return computeDaySeconds(getTime())
}

export function getEpoch() {
  return epoch
}

export function getPlaying() {
  return playing
}

export function getSpeed() {
  return speed
}

// ---------------------------------------------------------------- subscribers
const rawListeners = new Set()
const throttledEntries = new Set() // {ms, cb, lastFire, pending, timer}
const dateListeners = new Set()

function notifyThrottled() {
  const now = performance.now()
  for (const entry of throttledEntries) {
    const elapsed = now - entry.lastFire
    if (elapsed >= entry.ms) {
      entry.lastFire = now
      entry.pending = false
      entry.cb()
    } else if (!entry.pending) {
      entry.pending = true
      const delay = entry.ms - elapsed
      entry.timer = setTimeout(() => {
        entry.lastFire = performance.now()
        entry.pending = false
        entry.timer = null
        entry.cb()
      }, delay)
    }
  }
}

// ---- date-change notify: leading+trailing 300ms debounce, embedded inline
// (mirrors pulse's dateNotifier.ts but folded into this module — design §1
// says "含內嵌 dateNotifier"). lastSeenDateKey tracks the raw current value
// (updated every check, no debounce) so change-detection stays correct even
// while an emission is pending.
const DATE_QUIET_MS = 300
let lastSeenDateKey = computeDateKey(getTime())
let dateLastEmitted = lastSeenDateKey
let dateLastEmitAt = -Infinity
let datePendingKey = null
let dateTimer = null

function fireDateKey(key) {
  dateLastEmitted = key
  dateLastEmitAt = performance.now()
  for (const cb of dateListeners) cb(key)
}

function pushDateKey(key) {
  if (dateTimer === null && performance.now() - dateLastEmitAt >= DATE_QUIET_MS) {
    if (key !== dateLastEmitted) fireDateKey(key) // leading: quiet period already elapsed, no delay
    return
  }
  datePendingKey = key
  if (dateTimer !== null) clearTimeout(dateTimer)
  dateTimer = setTimeout(() => {
    dateTimer = null
    const k = datePendingKey
    datePendingKey = null
    if (k !== null && k !== dateLastEmitted) fireDateKey(k)
  }, DATE_QUIET_MS)
}

function checkDateKeyChange() {
  const key = computeDateKey(getTime())
  if (key !== lastSeenDateKey) {
    lastSeenDateKey = key
    pushDateKey(key)
  }
}

// ---------------------------------------------------------------- notifier lifecycle
// Idempotent by construction (design §5 trap #3): call after ANY state change
// that could affect eligibility (play/pause/subscribe/unsubscribe) — cheap to
// over-call, a no-op when the desired state already matches.
let notifierId = null

function ensureNotifier() {
  const shouldRun = playing && (throttledEntries.size > 0 || dateListeners.size > 0)
  if (shouldRun && notifierId === null) {
    notifierId = setInterval(notifierTick, 250)
  } else if (!shouldRun && notifierId !== null) {
    clearInterval(notifierId)
    notifierId = null
  }
}

function notifierTick() {
  // live-follow re-seed (design §1.6): only while default/goNow'd AND playing
  // AND at 1x — absorbs performance.now() drift from tab/laptop suspend by
  // re-anchoring straight to the real wall clock every tick.
  if (live && playing && speed === 1) {
    baseTime = Date.now() / 1000
    baseAnchor = performance.now()
  }
  epoch++ // ordering: epoch before callbacks, every pass (design §5 trap #2)
  notifyThrottled()
  checkDateKeyChange()
  // NOTE: raw subscribers are intentionally NOT notified here — subscribe()
  // only fires on discrete changes (design §1.3 differentiation from pulse).
}

function notifyDiscrete() {
  epoch++ // ordering: epoch before callbacks, every pass (design §5 trap #2)
  for (const cb of rawListeners) cb()
  notifyThrottled()
  checkDateKeyChange()
  ensureNotifier() // playing may have just changed
}

// ---------------------------------------------------------------- writes
// every write re-anchors (baseTime = current value, baseAnchor = now) BEFORE
// changing state, so a discrete change never causes a time jump — playing at
// 60x and changing to 300x continues from exactly where it was, not from
// baseTime as it stood at the OLD speed (design §1.2).

export function setTime(t) {
  baseTime = t
  baseAnchor = performance.now()
  live = false // scrub/seek always breaks live-follow (design §1.6)
  notifyDiscrete()
}

export function goNow() {
  baseTime = Date.now() / 1000
  baseAnchor = performance.now()
  live = true // the ONLY place live turns back on
  notifyDiscrete()
}

export function play() {
  if (playing) return
  baseTime = getTime()
  baseAnchor = performance.now()
  playing = true
  notifyDiscrete()
}

export function pause() {
  if (!playing) return
  baseTime = getTime()
  baseAnchor = performance.now()
  playing = false
  live = false // no longer "following now" once paused (design §1.6)
  notifyDiscrete()
}

export function toggle() {
  if (playing) pause()
  else play()
}

export function setSpeed(s) {
  baseTime = getTime()
  baseAnchor = performance.now()
  speed = s
  if (s !== 1) live = false // only 1x can ever be "live" (design §1.6)
  notifyDiscrete()
}

// ---------------------------------------------------------------- subscribe
export function subscribe(cb) {
  rawListeners.add(cb)
  return () => {
    rawListeners.delete(cb)
  }
}

export function subscribeThrottled(ms, cb) {
  const entry = { ms, cb, lastFire: -Infinity, pending: false, timer: null }
  throttledEntries.add(entry)
  ensureNotifier()
  return () => {
    if (entry.timer !== null) clearTimeout(entry.timer) // trap #3: clear our own pending trailing timer
    throttledEntries.delete(entry)
    ensureNotifier()
  }
}

export function subscribeDate(cb) {
  dateListeners.add(cb)
  ensureNotifier()
  return () => {
    dateListeners.delete(cb)
    ensureNotifier()
  }
}
