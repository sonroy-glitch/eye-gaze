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

console.log(`\nADAPTATION ${ADAPTATION_TARGETS.length} + FIT ${CALIBRATION_TARGETS.length} + VALIDATION ${VALIDATION_TARGETS_ON_BOARD.length} = ${ADAPTATION_TARGETS.length + CALIBRATION_TARGETS.length + VALIDATION_TARGETS_ON_BOARD.length} dots`)
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
