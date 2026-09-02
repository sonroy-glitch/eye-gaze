import type { BoardRect } from './board-mapping'
import type { HeadPose } from './types'

/**
 * v3 adds the head pose the model was fitted under. A v2 model cannot tell us
 * whether the player has since moved, so it is not worth silently migrating —
 * the key changes and those users calibrate once more.
 */
export const GAZE_CALIBRATION_STORAGE_KEY = 'armaan.chess.gazeCalibration.v3'

/**
 * Calibration is stored per gaze source. A model fitted against BlazeGaze's
 * output is meaningless applied to the landmark pipeline's — the two produce
 * completely different raw values — so sharing one key would silently hand a
 * newly-switched source someone else's mapping and look exactly like a broken
 * tracker. Keeping them separate also means switching back and forth costs no
 * recalibration.
 */
export function calibrationStorageKey(source: string): string {
  return `${GAZE_CALIBRATION_STORAGE_KEY}.${source}`
}

export type CalibrationPhase =
  | 'idle'
  /** Teaching WebEyeTrack's own on-device model where the user is looking. */
  | 'adapting'
  | 'collecting'
  | 'validating'
  | 'complete'
  | 'low-quality'

export interface CalibrationTarget {
  id: string
  fx: number
  fy: number
  label: string
}

export interface CalibrationSample {
  target: CalibrationTarget
  raw: { x: number; y: number }
  expected: { x: number; y: number }
  collectedAt: number
  /** Head pose while this sample was taken, when the tracker reported one. */
  head?: HeadPose | null
}

export interface CalibrationModel {
  version: 3
  kind: 'affine' | 'quadratic'
  coefficientsX: number[]
  coefficientsY: number[]
  boardRect: BoardRect
  sampleCount: number
  validationErrorPx: number
  validationErrorSquares: number
  qualityScore: number
  createdAt: number
  /**
   * Median head pose across the fit samples. The gaze estimate is only valid
   * near the pose it was fitted at, so this is what lets the tracker say "you
   * have moved, recalibrate" instead of just quietly getting worse.
   */
  headPose: HeadPose | null
  /** Fit samples discarded as outliers before the final fit. */
  droppedSamples: number
}

export interface CalibrationQuality {
  validationErrorPx: number
  validationErrorSquares: number
  qualityScore: number
  lowQuality: boolean
}

const BOARD_SIZE = 8

/**
 * Validation error (in board squares) above which a calibration is rejected.
 *
 * This is deliberately about one square. A webcam appearance-based gaze model
 * lands within roughly 2-3cm of the true point of regard on a laptop at arm's
 * length, and a fullscreen board square is ~1.5-2.5cm across, so ~1 square of
 * residual error *is* a working calibration for dwell selection: the stabiliser
 * votes over a 300ms window and the dwell needs a majority, both of which absorb
 * sub-square jitter. The previous 0.55 threshold demanded ~40px accuracy, which
 * no consumer webcam pipeline reaches — every calibration was rejected as
 * "low quality" no matter how carefully the user held their gaze.
 */
export const LOW_QUALITY_ERROR_SQUARES = 1.25

/**
 * Fit grid. Deliberately small: nine points is the least that still pins down a
 * full affine (and, when it wins, quadratic) map across the board, and the
 * client's first note was that calibration takes far too long. Sixteen fit dots
 * plus five validation dots ran ~26s of unbroken staring, which is exhausting
 * for exactly the users this is built for; 9 + 4 lands around 12s with no
 * measurable loss of accuracy at the reject line below.
 */
const FIT_TARGETS: Array<[number, number]> = [
  [0.5, 0.5],
  [3.5, 0.5],
  [7.5, 0.5],
  [0.5, 3.5],
  [3.5, 3.5],
  [7.5, 3.5],
  [0.5, 7.5],
  [3.5, 7.5],
  [7.5, 7.5],
]

/**
 * Adaptation grid, shown first.
 *
 * These do not feed our own regression at all — each one is handed to
 * WebEyeTrack's internal few-shot adaptation as ground truth for where the eyes
 * were, which refits the affine it applies to `normPog` before we ever see it.
 * That base is otherwise never personalised (its only other input is stray mouse
 * clicks, which we now suppress), so this is the layer that makes the raw stream
 * roughly right; our own fit afterwards cleans up what is left.
 *
 * Five points because the library keeps only its last five support points, and
 * they are spread to the corners and centre because that is the arrangement a
 * 2x3 affine is best determined by.
 */
const ADAPT_TARGETS: Array<[number, number]> = [
  [0.5, 0.5],
  [7.5, 0.5],
  [4, 4],
  [0.5, 7.5],
  [7.5, 7.5],
]

/** Held-out points, kept off the fit grid so the score is a real generalisation test. */
const VALIDATION_TARGETS: Array<[number, number]> = [
  [1.5, 1.5],
  [6.5, 1.5],
  [2.5, 5.5],
  [5.5, 6.5],
]

export const ADAPTATION_TARGETS: CalibrationTarget[] = ADAPT_TARGETS.map(([file, rank], i) => ({
  id: `adapt-${i + 1}`,
  fx: file / BOARD_SIZE,
  fy: rank / BOARD_SIZE,
  label: `${i + 1}/${ADAPT_TARGETS.length}`,
}))

export const CALIBRATION_TARGETS: CalibrationTarget[] = FIT_TARGETS.map(([file, rank], i) => ({
  id: `fit-${i + 1}`,
  fx: file / BOARD_SIZE,
  fy: rank / BOARD_SIZE,
  label: `${i + 1}/${FIT_TARGETS.length}`,
}))

export const VALIDATION_TARGETS_ON_BOARD: CalibrationTarget[] = VALIDATION_TARGETS.map(
  ([file, rank], i) => ({
    id: `validation-${i + 1}`,
    fx: file / BOARD_SIZE,
    fy: rank / BOARD_SIZE,
    label: `${i + 1}/${VALIDATION_TARGETS.length}`,
  }),
)

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/**
 * Feature vector for one raw gaze point, in *board-normalised* coordinates
 * (0 at the board centre, +/-0.5 at its edges).
 *
 * Normalising matters: fitted on raw viewport pixels the quadratic design matrix
 * carries terms up to x^2 ~ 1e6, so X'X spans ~1e13 and the Gaussian elimination
 * below returns numerical noise while still looking solvable. It also makes the
 * ridge term mean the same thing for every screen size. `rect` is stored on the
 * model, so fit and apply always normalise against the same frame.
 */
function features(
  point: { x: number; y: number },
  kind: CalibrationModel['kind'],
  rect: BoardRect,
): number[] {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const x = (point.x - (rect.left + width / 2)) / width
  const y = (point.y - (rect.top + height / 2)) / height
  if (kind === 'affine') return [x, y, 1]
  return [x, y, x * y, x * x, y * y, 1]
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]])

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]]

    const divisor = a[col][col]
    for (let j = col; j <= n; j++) a[col][j] /= divisor

    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = a[row][col]
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j]
    }
  }

  return a.map((row) => row[n])
}

function fitAxis(
  rows: number[][],
  values: number[],
  ridge = 1e-4,
): number[] | null {
  const cols = rows[0]?.length ?? 0
  if (!cols || rows.length < cols) return null

  const xtx = Array.from({ length: cols }, () => Array.from({ length: cols }, () => 0))
  const xty = Array.from({ length: cols }, () => 0)

  rows.forEach((row, i) => {
    for (let a = 0; a < cols; a++) {
      xty[a] += row[a] * values[i]
      for (let b = 0; b < cols; b++) xtx[a][b] += row[a] * row[b]
    }
  })

  for (let i = 0; i < cols; i++) xtx[i][i] += ridge
  return solveLinearSystem(xtx, xty)
}

function fitModel(
  samples: CalibrationSample[],
  kind: CalibrationModel['kind'],
  boardRect: BoardRect,
  validation: CalibrationQuality,
  droppedSamples = 0,
): CalibrationModel | null {
  const rows = samples.map((sample) => features(sample.raw, kind, boardRect))
  const coefficientsX = fitAxis(
    rows,
    samples.map((sample) => sample.expected.x),
  )
  const coefficientsY = fitAxis(
    rows,
    samples.map((sample) => sample.expected.y),
  )
  if (!coefficientsX || !coefficientsY) return null

  return {
    version: 3,
    kind,
    coefficientsX,
    coefficientsY,
    boardRect,
    sampleCount: samples.length,
    validationErrorPx: validation.validationErrorPx,
    validationErrorSquares: validation.validationErrorSquares,
    qualityScore: validation.qualityScore,
    createdAt: Date.now(),
    headPose: medianHeadPose(samples),
    droppedSamples,
  }
}

/**
 * Median head pose over the samples that reported one. Median rather than mean
 * because face reconstruction throws the occasional wild frame, and one of those
 * would otherwise define the pose every later drift measurement is compared to.
 */
export function medianHeadPose(samples: CalibrationSample[]): HeadPose | null {
  const poses = samples.map((sample) => sample.head).filter((head): head is HeadPose => !!head)
  if (!poses.length) return null
  const axis = (pick: (head: HeadPose) => number) => {
    const values = poses.map(pick).sort((a, b) => a - b)
    const mid = Math.floor(values.length / 2)
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  }
  return {
    origin: [
      axis((h) => h.origin[0]),
      axis((h) => h.origin[1]),
      axis((h) => h.origin[2]),
    ],
    vector: [
      axis((h) => h.vector[0]),
      axis((h) => h.vector[1]),
      axis((h) => h.vector[2]),
    ],
  }
}

/**
 * How far the head has moved from where the model was fitted, as a 0..1+ score
 * where 1 means "far enough that the mapping should not be trusted".
 *
 * Two independent components, combined by whichever is worse rather than by
 * averaging: a translation can be large with no rotation (leaning in) and a
 * rotation large with no translation (turning to look at someone), and either
 * one alone invalidates the fit.
 */
export function headDriftScore(from: HeadPose | null, to: HeadPose | null): number | null {
  if (!from || !to) return null

  const translation = Math.hypot(
    to.origin[0] - from.origin[0],
    to.origin[1] - from.origin[1],
    to.origin[2] - from.origin[2],
  )

  const dot =
    to.vector[0] * from.vector[0] + to.vector[1] * from.vector[1] + to.vector[2] * from.vector[2]
  const magnitude =
    Math.hypot(...to.vector) * Math.hypot(...from.vector)
  const angle = magnitude > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, dot / magnitude))) : 0

  return Math.max(translation / HEAD_DRIFT_TRANSLATION_LIMIT, angle / HEAD_DRIFT_ANGLE_LIMIT)
}

/**
 * Translation (cm) and rotation (radians) away from the calibration pose that
 * each count as a full unit of drift. Both are deliberately generous: normal
 * postural sway while thinking about a position is a couple of centimetres, and
 * we only want to speak up when the player has genuinely relocated.
 */
const HEAD_DRIFT_TRANSLATION_LIMIT = 7
const HEAD_DRIFT_ANGLE_LIMIT = 0.3

function applyCoefficients(coefficients: number[], row: number[]): number {
  return row.reduce((sum, value, i) => sum + value * (coefficients[i] ?? 0), 0)
}

function scoreSamples(
  samples: CalibrationSample[],
  kind: CalibrationModel['kind'],
  coefficientsX: number[],
  coefficientsY: number[],
  boardRect: BoardRect,
): CalibrationQuality {
  if (!samples.length) {
    return {
      validationErrorPx: Number.POSITIVE_INFINITY,
      validationErrorSquares: Number.POSITIVE_INFINITY,
      qualityScore: 0,
      lowQuality: true,
    }
  }

  const errors = samples.map((sample) => {
    const row = features(sample.raw, kind, boardRect)
    const x = applyCoefficients(coefficientsX, row)
    const y = applyCoefficients(coefficientsY, row)
    return Math.hypot(x - sample.expected.x, y - sample.expected.y)
  })
  errors.sort((a, b) => a - b)
  const median = errors[Math.floor(errors.length / 2)] ?? 0
  const p75 = errors[Math.floor(errors.length * 0.75)] ?? median
  const errorPx = median * 0.65 + p75 * 0.35
  const squareEdge = Math.max(1, Math.min(boardRect.width, boardRect.height) / BOARD_SIZE)
  const errorSquares = errorPx / squareEdge
  const qualityScore = clamp01(1 - errorSquares / LOW_QUALITY_ERROR_SQUARES)

  return {
    validationErrorPx: errorPx,
    validationErrorSquares: errorSquares,
    qualityScore,
    lowQuality: errorSquares > LOW_QUALITY_ERROR_SQUARES,
  }
}

/** True when a fitted model missed by more than the reject line allows. */
export function isLowQualityModel(model: CalibrationModel | null): boolean {
  return !model || !(model.validationErrorSquares <= LOW_QUALITY_ERROR_SQUARES)
}

export function targetToViewport(target: CalibrationTarget, rect: BoardRect): { x: number; y: number } {
  return {
    x: rect.left + target.fx * rect.width,
    y: rect.top + target.fy * rect.height,
  }
}

export function createCalibrationSample(
  target: CalibrationTarget,
  raw: { x: number; y: number },
  boardRect: BoardRect,
  head: HeadPose | null = null,
): CalibrationSample {
  return {
    target,
    raw,
    expected: targetToViewport(target, boardRect),
    collectedAt: Date.now(),
    head,
  }
}

export function robustPoint(samples: Array<{ x: number; y: number }>): { x: number; y: number } | null {
  if (!samples.length) return null
  const median = (values: number[]) => {
    const sorted = values.slice().sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  const mx = median(samples.map((sample) => sample.x))
  const my = median(samples.map((sample) => sample.y))
  const ranked = samples
    .map((sample) => ({ sample, d: Math.hypot(sample.x - mx, sample.y - my) }))
    .sort((a, b) => a.d - b.d)
  const keep = ranked.slice(0, Math.max(3, Math.ceil(ranked.length * 0.7))).map((entry) => entry.sample)
  return {
    x: median(keep.map((sample) => sample.x)),
    y: median(keep.map((sample) => sample.y)),
  }
}

export function applyCalibrationModel(
  model: CalibrationModel | null,
  point: { x: number; y: number },
): { x: number; y: number } {
  if (!model) return point
  const row = features(point, model.kind, model.boardRect)
  return {
    x: applyCoefficients(model.coefficientsX, row),
    y: applyCoefficients(model.coefficientsY, row),
  }
}

/**
 * Residual of each fit sample under a model fitted to all of them, in pixels.
 * Used to find the target the user was not actually looking at.
 */
function fitResiduals(
  samples: CalibrationSample[],
  kind: CalibrationModel['kind'],
  coefficientsX: number[],
  coefficientsY: number[],
  boardRect: BoardRect,
): number[] {
  return samples.map((sample) => {
    const row = features(sample.raw, kind, boardRect)
    return Math.hypot(
      applyCoefficients(coefficientsX, row) - sample.expected.x,
      applyCoefficients(coefficientsY, row) - sample.expected.y,
    )
  })
}

interface AffineFit {
  coefficientsX: number[]
  coefficientsY: number[]
  quality: CalibrationQuality
  samples: CalibrationSample[]
}

function fitAffine(
  samples: CalibrationSample[],
  validationSet: CalibrationSample[],
  boardRect: BoardRect,
): AffineFit | null {
  const rows = samples.map((sample) => features(sample.raw, 'affine', boardRect))
  const coefficientsX = fitAxis(
    rows,
    samples.map((sample) => sample.expected.x),
  )
  const coefficientsY = fitAxis(
    rows,
    samples.map((sample) => sample.expected.y),
  )
  if (!coefficientsX || !coefficientsY) return null
  return {
    coefficientsX,
    coefficientsY,
    quality: scoreSamples(validationSet, 'affine', coefficientsX, coefficientsY, boardRect),
    samples,
  }
}

/**
 * Fit points below which outlier rejection stops. Three is the algebraic minimum
 * for an affine map, but a fit that tight interpolates its own noise, so we stop
 * well above it.
 */
const MIN_FIT_SAMPLES = 6
/** A sample this many times the median residual is treated as "not looking". */
const OUTLIER_RESIDUAL_RATIO = 2.5
/** At most this many samples are ever discarded. */
const MAX_OUTLIER_DROPS = 2

/**
 * Is the raw gaze stream actually moving with the targets, or is it pinned?
 *
 * This exists because a dead signal does not look like a failure to the
 * regression — it looks like an easy problem with a boring answer. Least squares
 * fits "predict the average target", every validation dot is then wrong by
 * roughly its distance from the centre of the board, and the reported error is a
 * stable ~3.4 squares that does not move however carefully the player sits. It
 * reads as "this webcam is not good enough" when it is really "no estimate ever
 * reached the fit". Measuring the input spread separates the two cases before
 * the fit gets a chance to launder one into the other.
 */
export interface CalibrationDiagnostics {
  /** Mean distance of the raw samples from their own centroid, in px. */
  rawSpreadPx: number
  /** Mean distance of the target points from their centroid, in px. */
  targetSpreadPx: number
  /** rawSpread / targetSpread. Healthy trackers land well above the floor below. */
  signalRatio: number
  degenerate: boolean
}

/**
 * Below this ratio the raw stream is not tracking the targets in any usable way.
 * A compressed-but-real signal is fine — the affine map exists to stretch it —
 * but at 6% the same map amplifies the noise by ~17x along with the signal, so
 * there is nothing to recover even in principle.
 */
export const MIN_SIGNAL_RATIO = 0.06

function meanSpread(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length
  return points.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / points.length
}

export function diagnoseCalibrationSamples(
  samples: CalibrationSample[],
): CalibrationDiagnostics {
  const rawSpreadPx = meanSpread(samples.map((sample) => sample.raw))
  const targetSpreadPx = meanSpread(samples.map((sample) => sample.expected))
  const signalRatio = targetSpreadPx > 0 ? rawSpreadPx / targetSpreadPx : 0
  return {
    rawSpreadPx,
    targetSpreadPx,
    signalRatio,
    degenerate: samples.length > 2 && signalRatio < MIN_SIGNAL_RATIO,
  }
}

export function buildCalibrationModel(
  fitSamples: CalibrationSample[],
  validationSamples: CalibrationSample[],
  boardRect: BoardRect,
): CalibrationModel | null {
  const validationSet = validationSamples.length ? validationSamples : fitSamples

  let best = fitAffine(fitSamples, validationSet, boardRect)
  if (!best) return null

  /*
   * Outlier rejection.
   *
   * Least squares gives every target equal say, so one dot the user blinked
   * through, glanced past, or looked at while the tracker briefly lost the face
   * drags the whole map. With nine fit points that single bad sample is an
   * eighth of the evidence, and the result is a calibration that is subtly wrong
   * *everywhere* rather than obviously wrong in one corner — which is the hardest
   * kind of failure for the player to make sense of.
   *
   * So: find the worst-fitting sample, and if it stands well clear of the median
   * residual, drop it and refit. The held-out validation set decides whether the
   * drop actually helped, so this can never talk itself into a worse model.
   */
  let dropped = 0
  let candidate = best
  while (dropped < MAX_OUTLIER_DROPS && candidate.samples.length > MIN_FIT_SAMPLES) {
    const residuals = fitResiduals(
      candidate.samples,
      'affine',
      candidate.coefficientsX,
      candidate.coefficientsY,
      boardRect,
    )
    const sorted = residuals.slice().sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    let worstIndex = 0
    for (let i = 1; i < residuals.length; i++) {
      if (residuals[i] > residuals[worstIndex]) worstIndex = i
    }
    if (!(median > 0) || residuals[worstIndex] < median * OUTLIER_RESIDUAL_RATIO) break

    const trimmed = candidate.samples.filter((_, i) => i !== worstIndex)
    const refit = fitAffine(trimmed, validationSet, boardRect)
    if (!refit || !(refit.quality.validationErrorSquares < candidate.quality.validationErrorSquares)) {
      break
    }
    candidate = refit
    dropped += 1
    if (refit.quality.validationErrorSquares < best.quality.validationErrorSquares) best = refit
  }

  let chosenKind: CalibrationModel['kind'] = 'affine'
  let chosenQuality = best.quality
  const chosenSamples = best.samples

  /*
   * Quadratic is only worth trying with enough points to pin down its six
   * coefficients with room to spare. At the current grid size this never fires;
   * it is kept for a larger grid, and the margin below means curvature has to
   * clearly earn its place on held-out data rather than win a coin toss.
   */
  if (chosenSamples.length >= 12) {
    const quadraticRows = chosenSamples.map((sample) => features(sample.raw, 'quadratic', boardRect))
    const quadraticX = fitAxis(
      quadraticRows,
      chosenSamples.map((sample) => sample.expected.x),
      1e-2,
    )
    const quadraticY = fitAxis(
      quadraticRows,
      chosenSamples.map((sample) => sample.expected.y),
      1e-2,
    )

    if (quadraticX && quadraticY) {
      const quadraticQuality = scoreSamples(
        validationSet,
        'quadratic',
        quadraticX,
        quadraticY,
        boardRect,
      )
      if (
        Number.isFinite(quadraticQuality.validationErrorSquares) &&
        quadraticQuality.validationErrorSquares < chosenQuality.validationErrorSquares * 0.82
      ) {
        chosenKind = 'quadratic'
        chosenQuality = quadraticQuality
      }
    }
  }

  return fitModel(chosenSamples, chosenKind, boardRect, chosenQuality, dropped)
}

export function saveCalibrationModel(model: CalibrationModel, source: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(calibrationStorageKey(source), JSON.stringify(model))
}

export function loadCalibrationModel(source: string): CalibrationModel | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(calibrationStorageKey(source))
    if (!raw) return null
    const model = JSON.parse(raw) as CalibrationModel
    if (
      model?.version !== 3 ||
      !Array.isArray(model.coefficientsX) ||
      !Array.isArray(model.coefficientsY) ||
      !model.boardRect
    ) {
      return null
    }
    return model
  } catch {
    return null
  }
}

export function clearCalibrationModel(source: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(calibrationStorageKey(source))
}
