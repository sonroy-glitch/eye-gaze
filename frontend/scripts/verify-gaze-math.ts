/**
 * Offline checks on the parts of the gaze pipeline that are pure maths.
 *
 * The tracker itself cannot be exercised without a camera and a real face, but
 * the filter, the head-drift score and the calibration fit are all deterministic
 * functions, and they are where the accuracy actually comes from. Run with
 * `npm run verify:gaze`.
 */
import { OneEuroFilter2D, smoothingToMinCutoff } from '@/lib/eye-tracking/one-euro'
import {
  buildCalibrationModel,
  diagnoseCalibrationSamples,
  MIN_SIGNAL_RATIO,
  applyCalibrationModel,
  createCalibrationSample,
  headDriftScore,
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS_ON_BOARD,
  ADAPTATION_TARGETS,
  targetToViewport,
} from '@/lib/eye-tracking/calibration-model'
import {
  REARM_MOVE_FRACTION,
  REARM_TIMEOUT_MS,
} from '@/lib/eye-tracking/useGazeRegionDwell'
import { projectHeadFeature, headSmoothingAlpha } from '@/lib/eye-tracking/mediapipe-source'
/** Matches HEAD_TRANSLATION_GAIN; the speed metric is scaled by it. */
const HEAD_TRANSLATION_GAIN_FOR_TEST = 2.2
import { GAZE_SOURCE_ORDER } from '@/lib/eye-tracking/types'
import { createGame, getLegalMoves, getPieceAt } from '@/lib/chess/engine'
import { toVisual } from '@/lib/chess/orientation'
import type { PieceColor } from '@/lib/chess/types'

const board = { left: 200, top: 100, width: 800, height: 800 }
const squarePx = board.width / 8
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---------------------------------------------------------------- One Euro
{
  // A stationary signal with +-6px noise: how much noise survives?
  const f = new OneEuroFilter2D({ minCutoff: smoothingToMinCutoff(0.7) })
  let t = 0
  let maxDev = 0
  let rng = 12345
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let i = 0; i < 200; i++) {
    t += 33
    const out = f.filter(500 + rand() * 6, 500 + rand() * 6, t)
    if (i > 30) maxDev = Math.max(maxDev, Math.hypot(out.x - 500, out.y - 500))
  }
  check('fixation jitter is suppressed to well under a square', maxDev < squarePx * 0.2,
    `max deviation ${maxDev.toFixed(1)}px vs square ${squarePx}px`)

  // A saccade: how many frames to get within 10% of the new target?
  const g = new OneEuroFilter2D({ minCutoff: smoothingToMinCutoff(0.7) })
  let tt = 0
  for (let i = 0; i < 30; i++) { tt += 33; g.filter(300, 300, tt) }
  let frames = 0
  let settled = 0
  for (let i = 0; i < 40; i++) {
    tt += 33
    frames++
    const out = g.filter(800, 300, tt)
    if (Math.abs(out.x - 800) < 50) { settled = frames; break }
  }
  check('saccade settles quickly (adaptive cutoff opens up)', settled > 0 && settled <= 8,
    `${settled} frames (~${(settled * 33).toFixed(0)}ms) to within 50px of a 500px jump`)

  // Compare against what the old fixed-alpha EMA would have done.
  let ema = 300
  let emaFrames = 0
  for (let i = 0; i < 40; i++) {
    emaFrames++
    ema = ema + 0.27 * (800 - ema)
    if (Math.abs(ema - 800) < 50) break
  }
  console.log(`      (old fixed EMA alpha=0.27 took ${emaFrames} frames / ~${emaFrames * 33}ms)`)
}

// ------------------------------------------------------------- head drift
{
  const at = { origin: [0, 0, 60] as [number, number, number], vector: [0, 0, -1] as [number, number, number] }
  check('no movement reads as no drift', headDriftScore(at, at) === 0)
  const leaned = { origin: [0, 0, 53] as [number, number, number], vector: [0, 0, -1] as [number, number, number] }
  check('leaning 7cm closer reaches the drift limit', Math.abs((headDriftScore(at, leaned) ?? 0) - 1) < 1e-6,
    `score ${headDriftScore(at, leaned)?.toFixed(2)}`)
  const swayed = { origin: [2, 0, 60] as [number, number, number], vector: [0, 0, -1] as [number, number, number] }
  check('normal 2cm postural sway does not trip it', (headDriftScore(at, swayed) ?? 1) < 0.4,
    `score ${headDriftScore(at, swayed)?.toFixed(2)}`)
  check('unknown pose yields null, not a false alarm', headDriftScore(null, at) === null)
}

// ------------------------------------------------- robust calibration fit
{
  // Simulate a tracker whose raw output is a skewed, offset version of truth,
  // plus noise — the affine fit should recover it.
  let rng = 999
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const rawFor = (x: number, y: number) => ({
    x: 0.82 * x + 0.05 * y + 90 + rand() * 7,
    y: 0.9 * y - 0.04 * x + 40 + rand() * 7,
  })

  const mk = (targets: typeof CALIBRATION_TARGETS) =>
    targets.map((t) => {
      const v = targetToViewport(t, board)
      return createCalibrationSample(t, rawFor(v.x, v.y), board, {
        origin: [0, 0, 60], vector: [0, 0, -1],
      })
    })

  const fit = mk(CALIBRATION_TARGETS)
  const val = mk(VALIDATION_TARGETS_ON_BOARD)
  const clean = buildCalibrationModel(fit, val, board)
  check('clean calibration fits under the reject line', !!clean && clean.validationErrorSquares < 1.25,
    `${clean?.validationErrorSquares.toFixed(2)} squares, ${clean?.kind}`)
  check('model records the head pose it was fitted at', !!clean?.headPose)

  // Now poison one target: the user blinked and the sample landed far away.
  const poisoned = mk(CALIBRATION_TARGETS)
  poisoned[4] = createCalibrationSample(
    CALIBRATION_TARGETS[4],
    { x: rawFor(0, 0).x + 260, y: rawFor(0, 0).y + 220 },
    board,
    { origin: [0, 0, 60], vector: [0, 0, -1] },
  )
  const robust = buildCalibrationModel(poisoned, val, board)
  check('an outlier target is detected and dropped', (robust?.droppedSamples ?? 0) >= 1,
    `dropped ${robust?.droppedSamples}`)
  check('outlier rejection keeps the fit usable', !!robust && robust.validationErrorSquares < 1.25,
    `${robust?.validationErrorSquares.toFixed(2)} squares`)

  // What would it have been without rejection? Fit with the outlier forced in.
  const naive = buildCalibrationModel(poisoned.slice(0, 6), val, board)
  console.log(`      (a 6-point fit that cannot drop anything: ${naive?.validationErrorSquares.toFixed(2)} squares)`)

  // Round-trip accuracy on the board.
  if (clean) {
    let worst = 0
    for (const t of VALIDATION_TARGETS_ON_BOARD) {
      const v = targetToViewport(t, board)
      const p = applyCalibrationModel(clean, rawFor(v.x, v.y))
      worst = Math.max(worst, Math.hypot(p.x - v.x, p.y - v.y) / squarePx)
    }
    check('worst held-out target lands within a square', worst < 1.0, `${worst.toFixed(2)} squares`)
  }
}

// ------------------------------------------- the dead-signal signature
{
  const centre = { x: board.left + board.width / 2, y: board.top + board.height / 2 }
  const stuck = (targets: typeof CALIBRATION_TARGETS) =>
    targets.map((t) => createCalibrationSample(t, { x: centre.x, y: centre.y }, board))

  const fit = stuck(CALIBRATION_TARGETS)
  const model = buildCalibrationModel(fit, stuck(VALIDATION_TARGETS_ON_BOARD), board)
  // Documents *why* 3.4 is the number to recognise: it is what least squares
  // reports when it can only fit "predict the average target".
  check(
    'a pinned gaze stream produces the ~3.4-square signature',
    !!model && Math.abs(model.validationErrorSquares - 3.4) < 0.2,
    `${model?.validationErrorSquares.toFixed(2)} squares`,
  )
  check(
    'and is caught as a dead signal rather than reported as poor accuracy',
    diagnoseCalibrationSamples(fit).degenerate,
    `signal ratio ${(diagnoseCalibrationSamples(fit).signalRatio * 100).toFixed(1)}% (floor ${MIN_SIGNAL_RATIO * 100}%)`,
  )

  // A real but heavily compressed signal must NOT be written off as dead.
  let rng = 4242
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const compressed = CALIBRATION_TARGETS.map((t) => {
    const v = targetToViewport(t, board)
    return createCalibrationSample(
      t,
      { x: centre.x + (v.x - centre.x) * 0.25 + rand() * 3, y: centre.y + (v.y - centre.y) * 0.25 + rand() * 3 },
      board,
    )
  })
  const compressedDiag = diagnoseCalibrationSamples(compressed)
  check('a compressed but real signal is not written off', !compressedDiag.degenerate,
    `signal ratio ${(compressedDiag.signalRatio * 100).toFixed(0)}%`)
}


// ------------------------------------------ coarse-to-fine selection maths
{
  const BOARD = 8
  const frame = { left: 200, top: 100, width: 800, height: 800 }
  const cell = frame.width / BOARD

  /** Mirrors the CSS transform applied to the grid for a region. */
  const zoomedGridRect = (region: { row: number; col: number; size: number }) => {
    const k = BOARD / region.size
    return {
      left: frame.left - k * region.col * cell,
      top: frame.top - k * region.row * cell,
      width: frame.width * k,
      height: frame.height * k,
    }
  }
  /** Mirrors pointToSquare's arithmetic on whichever rect it is handed. */
  const cellAt = (rect: typeof frame, x: number, y: number) => ({
    col: Math.floor(((x - rect.left) / rect.width) * BOARD),
    row: Math.floor(((y - rect.top) / rect.height) * BOARD),
  })

  // Walk the stack the way the game does: quarter of the frame each time.
  // Target h8 -> drawn cell (row 0, col 7) with white at the top.
  let region = { row: 0, col: 0, size: BOARD }
  const picks = [
    { row: 0, col: 1 }, // top-right quarter of the board  -> rows 0-3, cols 4-7
    { row: 0, col: 1 }, // top-right of that               -> rows 0-1, cols 6-7
    { row: 0, col: 1 }, // top-right of that               -> row 0,   col 7
  ]
  for (const pick of picks) {
    const half = region.size / 2
    region = {
      row: region.row + pick.row * half,
      col: region.col + pick.col * half,
      size: half,
    }
  }
  check('three halvings reach exactly one square', region.size === 1 && region.row === 0 && region.col === 7,
    `landed on drawn cell ${region.row},${region.col} size ${region.size}`)

  // Every step's target is half the visible frame, so the pixel tolerance is a
  // quarter of the frame at *every* step — that uniformity is the whole point.
  const tolerances: number[] = []
  let size = BOARD
  while (size > 1) {
    // The visible frame always spans `frame.width` px, whatever the region size.
    tolerances.push(frame.width / 4)
    size /= 2
  }
  const uniform = tolerances.every((t) => Math.abs(t - tolerances[0]) < 1e-9)
  check('every step of the stack tolerates the same pixel error', uniform,
    `${tolerances.map((t) => t.toFixed(0) + 'px').join(', ')}`)

  const directTolerancePx = cell / 2
  check('the stack tolerates 4x the gaze error that direct selection needs',
    tolerances[0] / directTolerancePx === 4,
    `${tolerances[0].toFixed(0)}px vs ${directTolerancePx.toFixed(0)}px direct ` +
      `(${(tolerances[0] / cell).toFixed(1)} squares vs ${(directTolerancePx / cell).toFixed(1)})`)

  // And the magnified grid must still hit-test to the region it displays.
  const zoomed = zoomedGridRect({ row: 4, col: 4, size: 4 })
  const tl = cellAt(zoomed, frame.left + 1, frame.top + 1)
  const br = cellAt(zoomed, frame.left + frame.width - 1, frame.top + frame.height - 1)
  check('the magnified frame shows exactly the chosen region',
    tl.row === 4 && tl.col === 4 && br.row === 7 && br.col === 7,
    `top-left cell ${tl.row},${tl.col}; bottom-right ${br.row},${br.col}`)
}

// ------------------------------------------- Region dwell re-arms on zoom
{
  /*
   * The zoom stack is only playable if a descent can actually run to the bottom
   * without the player looking away. `useGazeRegionDwell` latches after each
   * commit so one long look cannot fire the same region twice, and the latch
   * releases when the gaze moves to a different grid cell. The catch is that a
   * magnification renumbers the cells against a new frame, so "the same cell"
   * before and after a zoom are different places on the board. A player whose
   * next quarter happens to carry the same index stayed latched, and the board
   * stopped responding until they looked elsewhere and came back.
   *
   * This replays the hook's latch rule over a full descent, with the gaze
   * following the target square across each zoom, and asserts every square on
   * the board is still reachable.
   */
  const BOARD_N = 8
  const DIVISIONS = 2
  const rect = { left: 0, top: 0, width: 800, height: 800 }

  /** Screen point of a square's centre under the currently magnified region. */
  const screenPos = (sr: number, sc: number, reg: { row: number; col: number; size: number }) => ({
    x: rect.left + ((sc + 0.5 - reg.col) / reg.size) * rect.width,
    y: rect.top + ((sr + 0.5 - reg.row) / reg.size) * rect.height,
  })

  /** Does a steady look at `square` reach it, given whether the dwell re-arms? */
  const descends = (square: { row: number; col: number }, reArm: boolean) => {
    let region = { row: 0, col: 0, size: BOARD_N }
    let latched: { row: number; col: number } | null = null
    // Each iteration is one completed dwell; the loop bound is generous so a
    // stall shows up as "ran out" rather than looping forever.
    for (let step = 0; step < 32; step++) {
      const g = screenPos(square.row, square.col, region)
      const stable = {
        row: Math.min(DIVISIONS - 1, Math.floor(((g.y - rect.top) / rect.height) * DIVISIONS)),
        col: Math.min(DIVISIONS - 1, Math.floor(((g.x - rect.left) / rect.width) * DIVISIONS)),
      }
      if (latched && (latched.row !== stable.row || latched.col !== stable.col)) latched = null
      if (latched) return { reached: false, region }

      latched = stable
      const half = region.size / DIVISIONS
      region = {
        row: region.row + stable.row * half,
        col: region.col + stable.col * half,
        size: half,
      }
      if (half <= 1) return { reached: true, region }
      if (reArm) latched = null
    }
    return { reached: false, region }
  }

  let reachableWithoutReArm = 0
  let reachableWithReArm = 0
  let landedCorrectly = 0
  for (let r = 0; r < BOARD_N; r++) {
    for (let c = 0; c < BOARD_N; c++) {
      if (descends({ row: r, col: c }, false).reached) reachableWithoutReArm++
      const withReArm = descends({ row: r, col: c }, true)
      if (withReArm.reached) reachableWithReArm++
      if (withReArm.region.row === r && withReArm.region.col === c) landedCorrectly++
    }
  }

  check('re-arming the region dwell keeps every square reachable', reachableWithReArm === 64,
    `${reachableWithReArm}/64 squares`)
  check('and each descent lands on the square that was actually looked at', landedCorrectly === 64,
    `${landedCorrectly}/64 squares`)
  check('the stale latch this guards against really does strand squares',
    reachableWithoutReArm < 64,
    `without re-arming only ${reachableWithoutReArm}/64 are reachable`)

  /*
   * Re-arming alone is not enough. A commit changes the view, and the player
   * then has to find their next target on a board that just changed scale --
   * a visual search, median around 800ms, longer than the 700ms dwell. Their
   * gaze is still parked where it was, and a parked gaze is the most stable
   * input the vote can receive, so it clears the threshold and commits a region
   * nobody chose. The movement gate exists to make a parked gaze inert.
   */
  /**
   * The gate as the hook applies it: travel is measured as a fraction of the
   * frame width, against the constants the hook actually uses.
   */
  const gateOpens = (travelFrac: number, elapsedMs: number) =>
    travelFrac >= REARM_MOVE_FRACTION || elapsedMs >= REARM_TIMEOUT_MS

  check('a gaze still parked where it committed cannot commit again',
    !gateOpens(0, 0) && !gateOpens(0.05, 500) && !gateOpens(0.14, 1500),
    `needs ${(REARM_MOVE_FRACTION * 100).toFixed(0)}% of frame travel`)
  check('a gaze that has moved to a new target arms immediately',
    gateOpens(REARM_MOVE_FRACTION, 0) && gateOpens(0.4, 0),
    'no added delay once the player has looked away')
  check('and a player who wants an adjacent region is never locked out',
    gateOpens(0, REARM_TIMEOUT_MS),
    `gate expires after ${REARM_TIMEOUT_MS}ms`)
}

// --------------------------------------------- Head pointer projection
{
  /*
   * The head-pointer source only works if a comfortable head movement already
   * spans most of the screen before calibration touches it. Too small a spread
   * and the affine fit has to amplify it, multiplying noise with it; too large
   * and the player has to crane their neck to reach the board edges.
   *
   * The same diagnostic that catches a dead eye tracker would reject a head
   * signal that barely moves, so this is the check that says head mode can be
   * calibrated at all.
   */
  const W = 1920
  const H = 1080

  /** A comfortable head range: ~0.12 of the frame of translation, ~0.25rad turn. */
  const atExtreme = (sx: number, sy: number) =>
    projectHeadFeature(
      {
        ex: 0, ey: 0, eyLid: 0, vergence: 0, aperture: 0, roll: 0,
        headX: 0.12 * sx,
        headY: 0.12 * sy,
        yaw: 0.25 * sx,
        pitch: 0.25 * sy,
        headScale: 0.1,
      },
      W,
      H,
    )

  const left = atExtreme(-1, 0).x
  const right = atExtreme(1, 0).x
  const up = atExtreme(0, -1).y
  const down = atExtreme(0, 1).y

  const spanX = (right - left) / W
  const spanY = (down - up) / H

  check('head pointing spans most of the screen at a comfortable range',
    spanX >= 0.8 && spanY >= 0.8,
    `${(spanX * 100).toFixed(0)}% wide, ${(spanY * 100).toFixed(0)}% tall`)
  check('and does not overshoot so far that the edges need a neck crane',
    spanX <= 2.2 && spanY <= 2.2,
    `${spanX.toFixed(2)}x / ${spanY.toFixed(2)}x of the screen`)

  const centre = atExtreme(0, 0)
  check('a centred head points at the centre of the screen',
    Math.abs(centre.x - W / 2) < 1 && Math.abs(centre.y - H / 2) < 1,
    `${centre.x.toFixed(0)}, ${centre.y.toFixed(0)}`)

  // Signs must match the iris projection or the calibration fits a mirror.
  check('turning right moves the pointer right, lowering the chin moves it down',
    right > left && down > up)

  /*
   * Head pointing must survive the confidence chain, which is where it first
   * failed in the real app: the cursor tracked perfectly and nothing ever
   * selected. Head movement is the input here, so scoring it as drift away from
   * the calibration pose bottomed the penalty out and pushed every frame under
   * the dwell's MIN_FRAME_CONFIDENCE, which silently discards them.
   */
  const MIN_FRAME_CONFIDENCE = 0.15
  const HEAD_FRAME_CONFIDENCE = 0.9
  const WORST_QUALITY = 0.45

  /** The chain from useGazeTracking: frame x calibration quality x drift. */
  const effective = (driftPenalty: number) =>
    HEAD_FRAME_CONFIDENCE * WORST_QUALITY * driftPenalty

  check('head pointing clears the dwell confidence floor when drift is ignored',
    effective(1) >= MIN_FRAME_CONFIDENCE,
    `${effective(1).toFixed(3)} vs floor ${MIN_FRAME_CONFIDENCE}`)
  check('and would have fallen under it if drift were still penalised',
    effective(0.25) < MIN_FRAME_CONFIDENCE,
    `${effective(0.25).toFixed(3)} with the drift penalty applied`)

  /*
   * Adaptive head smoothing has to win on both counts at once, because the
   * fixed value could only ever win on one: heavy smoothing made calibration
   * sample mid-transit, light smoothing passed the head's tremor through and
   * the pointer shook. Simulate both regimes against the old fixed 0.35.
   */
  const FIXED = 0.35
  const TREMOR = 0.0015 // per-frame residual of a head held on a target

  let rng = 777
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1

  /** Residual noise on a held pose, as a fraction of the input tremor. */
  const heldNoise = (adaptive: boolean) => {
    let state = 0
    let peak = 0
    for (let i = 0; i < 400; i++) {
      const sample = rand() * TREMOR
      const speed = Math.abs(sample - state) * HEAD_TRANSLATION_GAIN_FOR_TEST
      const alpha = adaptive ? headSmoothingAlpha(speed) : FIXED
      state += alpha * (sample - state)
      if (i > 50) peak = Math.max(peak, Math.abs(state))
    }
    return peak / TREMOR
  }

  /** Frames to reach 95% of a deliberate move. */
  const settleFrames = (adaptive: boolean) => {
    const targetValue = 0.1 // a real aiming movement
    let state = 0
    for (let i = 0; i < 200; i++) {
      const speed = Math.abs(targetValue - state) * HEAD_TRANSLATION_GAIN_FOR_TEST
      const alpha = adaptive ? headSmoothingAlpha(speed) : FIXED
      state += alpha * (targetValue - state)
      if (state >= targetValue * 0.95) return i + 1
    }
    return 200
  }

  const adaptiveNoise = heldNoise(true)
  const fixedNoise = heldNoise(false)
  const adaptiveSettle = settleFrames(true)
  const fixedSettle = settleFrames(false)

  check('a held head is smoothed harder than the fixed filter managed',
    adaptiveNoise < fixedNoise,
    `${(adaptiveNoise * 100).toFixed(0)}% of tremor vs ${(fixedNoise * 100).toFixed(0)}%`)
  check('and a deliberate move still settles about as fast',
    adaptiveSettle <= fixedSettle + 1,
    `${adaptiveSettle} frames vs ${fixedSettle}`)
  check('the filter opens up for movement and closes for stillness',
    headSmoothingAlpha(0) < headSmoothingAlpha(0.02) &&
      headSmoothingAlpha(0.02) <= headSmoothingAlpha(1),
    `still ${headSmoothingAlpha(0).toFixed(2)}, moving ${headSmoothingAlpha(0.02).toFixed(2)}`)

  check('the T key cycle reaches every source and returns',
    GAZE_SOURCE_ORDER.length === 3 &&
      new Set(GAZE_SOURCE_ORDER).size === 3 &&
      GAZE_SOURCE_ORDER.includes('headpointer'),
    GAZE_SOURCE_ORDER.join(' -> '))
}

// ------------------------------------- Descent is confined to playable ground
{
  /*
   * The zoom must not narrow toward anything the player cannot act on. Landing
   * a three-look descent on an opponent piece is three looks spent for nothing,
   * and rejecting it only after the fact is what "I cannot select, I cannot
   * move" feels like from the chair. Mirrors the containment test the game page
   * applies to each quarter.
   */
  const game = createGame()
  const HUMAN: PieceColor = 'white'
  const N = 8

  /** Drawn cells holding one of the player's own pieces, nothing picked yet. */
  const ownCells: Array<{ row: number; col: number }> = []
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const piece = getPieceAt(game.board, row, col)
      if (piece?.color === HUMAN) ownCells.push(toVisual({ row, col }, 'white-bottom'))
    }
  }

  const quarterAllowed = (
    cells: Array<{ row: number; col: number }>,
    region: { row: number; col: number; size: number },
    picked: { row: number; col: number },
  ) => {
    const half = region.size / 2
    const top = region.row + picked.row * half
    const left = region.col + picked.col * half
    return cells.some(
      (c) => c.row >= top && c.row < top + half && c.col >= left && c.col < left + half,
    )
  }

  const whole = { row: 0, col: 0, size: N }
  const topLeft = quarterAllowed(ownCells, whole, { row: 0, col: 0 })
  const topRight = quarterAllowed(ownCells, whole, { row: 0, col: 1 })
  const botLeft = quarterAllowed(ownCells, whole, { row: 1, col: 0 })
  const botRight = quarterAllowed(ownCells, whole, { row: 1, col: 1 })

  check('at the start the descent refuses both halves holding only black',
    !topLeft && !topRight,
    `top-left ${topLeft}, top-right ${topRight}`)
  check('and accepts the two holding white',
    botLeft && botRight,
    `bottom-left ${botLeft}, bottom-right ${botRight}`)
  check('white has 16 pieces to aim at and no more', ownCells.length === 16,
    `${ownCells.length} selectable cells`)

  // With a piece picked, only its legal destinations (and itself) are open.
  const e2 = { row: 6, col: 4 }
  const moveCells = [
    ...getLegalMoves(game, e2.row, e2.col).map((m) => toVisual(m, 'white-bottom')),
    toVisual(e2, 'white-bottom'),
  ]
  check('a picked pawn opens only its own legal ground', moveCells.length === 3,
    `${moveCells.length} cells: the pawn plus e3 and e4`)
  const reachable = quarterAllowed(moveCells, whole, { row: 1, col: 1 })
  const unreachable = quarterAllowed(moveCells, whole, { row: 0, col: 0 })
  check('and keeps the descent out of the far side of the board',
    reachable && !unreachable,
    `near ${reachable}, far ${unreachable}`)
}

console.log(`\nADAPTATION ${ADAPTATION_TARGETS.length} + FIT ${CALIBRATION_TARGETS.length} + VALIDATION ${VALIDATION_TARGETS_ON_BOARD.length} = ${ADAPTATION_TARGETS.length + CALIBRATION_TARGETS.length + VALIDATION_TARGETS_ON_BOARD.length} dots`)
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
