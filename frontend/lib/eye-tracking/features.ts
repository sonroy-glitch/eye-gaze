import type { FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision'

/**
 * Face-mesh -> gaze feature extraction.
 *
 * The raw iris pixel position is *not* a usable gaze signal on its own: it moves
 * with head translation, head rotation, camera distance and face size far more
 * than it moves with actual gaze direction. So instead of shipping iris
 * coordinates downstream, we build a small, normalised descriptor that is
 * (approximately) invariant to everything except where the person is looking,
 * and leave the person-specific mapping to the calibrated regressor.
 *
 * Every quantity here is expressed in a *face-local* frame:
 *   origin  — midpoint between the two eye centres
 *   x-axis  — the inter-ocular line (so head roll is factored out)
 *   y-axis  — perpendicular to it
 *   scale   — the inter-ocular distance (so camera distance is factored out)
 */

// --- Landmark indices (MediaPipe canonical 478-point mesh, refined irises) ---
// "Right"/"left" follow MediaPipe's subject-relative naming. Only consistency
// matters downstream, since calibration learns the sign of every term anyway.
const RIGHT_EYE_INNER = 133
const RIGHT_EYE_OUTER = 33
const RIGHT_LID_UPPER = 159
const RIGHT_LID_LOWER = 145
const RIGHT_IRIS_CENTER = 468

const LEFT_EYE_INNER = 362
const LEFT_EYE_OUTER = 263
const LEFT_LID_UPPER = 386
const LEFT_LID_LOWER = 374
const LEFT_IRIS_CENTER = 473

const NOSE_TIP = 1
const CHIN = 152
const FOREHEAD = 10

/** The per-frame descriptor the calibration model is fitted against. */
export interface GazeFeature {
  /** Iris horizontal offset from the eye-corner midpoint, in face frame / IOD. */
  ex: number
  /** Iris vertical offset from the eye-corner midpoint, in face frame / IOD. */
  ey: number
  /** Iris vertical position *within the eyelid aperture*, -0.5 (top) .. 0.5. */
  eyLid: number
  /** Right-minus-left horizontal offset; a weak depth/vergence cue. */
  vergence: number
  /** Eyelid aperture / IOD. People squint when looking down, so this helps Y. */
  aperture: number
  /** Head yaw (radians, + = turned toward screen right in the mirrored view). */
  yaw: number
  /** Head pitch (radians, + = chin down / looking down). */
  pitch: number
  /** Head roll (radians). */
  roll: number
  /** Face centre X in normalised image space, mirrored, centred on 0. */
  headX: number
  /** Face centre Y in normalised image space, centred on 0. */
  headY: number
  /** Inter-ocular distance in normalised image units — a proxy for distance. */
  headScale: number
}

export const FEATURE_KEYS = [
  'ex',
  'ey',
  'eyLid',
  'vergence',
  'aperture',
  'yaw',
  'pitch',
  'roll',
  'headX',
  'headY',
  'headScale',
] as const satisfies readonly (keyof GazeFeature)[]

export const ZERO_FEATURE: GazeFeature = {
  ex: 0,
  ey: 0,
  eyLid: 0,
  vergence: 0,
  aperture: 0.35,
  yaw: 0,
  pitch: 0,
  roll: 0,
  headX: 0,
  headY: 0,
  headScale: 0.12,
}

export function isFeatureFinite(f: GazeFeature): boolean {
  return FEATURE_KEYS.every((k) => Number.isFinite(f[k]))
}

type Vec2 = { x: number; y: number }

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
const len = (a: Vec2): number => Math.hypot(a.x, a.y)

/**
 * Build the gaze descriptor for one frame. Returns null when the landmarks are
 * degenerate (face at an extreme angle, detector hiccup), so callers can drop
 * the frame instead of feeding garbage into the model.
 */
export function extractGazeFeature(
  landmarks: NormalizedLandmark[],
  result: FaceLandmarkerResult,
): GazeFeature | null {
  if (!landmarks || landmarks.length <= LEFT_IRIS_CENTER) return null

  const rightCentre = mid(landmarks[RIGHT_EYE_INNER], landmarks[RIGHT_EYE_OUTER])
  const leftCentre = mid(landmarks[LEFT_EYE_INNER], landmarks[LEFT_EYE_OUTER])

  const eyeAxis = sub(leftCentre, rightCentre)
  const iod = len(eyeAxis)
  // Face too small / landmarks collapsed: nothing reliable to normalise against.
  if (!(iod > 1e-4)) return null

  // Face-local basis: axisX along the inter-ocular line, axisY perpendicular.
  const axisX = { x: eyeAxis.x / iod, y: eyeAxis.y / iod }
  const axisY = { x: -axisX.y, y: axisX.x }

  /** Project an image-space offset into the face frame, scaled by the IOD. */
  const project = (v: Vec2) => ({ x: dot(v, axisX) / iod, y: dot(v, axisY) / iod })

  const eyeMetrics = (
    innerI: number,
    outerI: number,
    upperI: number,
    lowerI: number,
    irisI: number,
  ) => {
    const centre = mid(landmarks[innerI], landmarks[outerI])
    const iris = landmarks[irisI]
    const upper = landmarks[upperI]
    const lower = landmarks[lowerI]

    // Iris relative to the eye-corner midpoint: the primary gaze signal.
    const corner = project(sub(iris, centre))

    // Iris relative to the eyelid aperture. Because the lids follow the eye
    // vertically, this is a *much* stronger vertical cue than the corner offset
    // alone — vertical gaze is the axis a corner-only feature gets worst.
    const lidMid = mid(upper, lower)
    const apertureVec = project(sub(upper, lower))
    const apertureH = Math.abs(apertureVec.y)
    const lidRel = apertureH > 1e-4 ? project(sub(iris, lidMid)).y / apertureH : 0

    return { x: corner.x, y: corner.y, lid: lidRel, aperture: apertureH }
  }

  const right = eyeMetrics(
    RIGHT_EYE_INNER,
    RIGHT_EYE_OUTER,
    RIGHT_LID_UPPER,
    RIGHT_LID_LOWER,
    RIGHT_IRIS_CENTER,
  )
  const left = eyeMetrics(
    LEFT_EYE_INNER,
    LEFT_EYE_OUTER,
    LEFT_LID_UPPER,
    LEFT_LID_LOWER,
    LEFT_IRIS_CENTER,
  )

  // Averaging the two eyes halves the independent per-eye landmark noise.
  // X is negated because the preview (and the user's mental model) is mirrored:
  // looking toward the screen's right moves the iris toward the image's left.
  const ex = -((right.x + left.x) / 2)
  const ey = (right.y + left.y) / 2
  const eyLid = (right.lid + left.lid) / 2
  const vergence = -(right.x - left.x)
  const aperture = (right.aperture + left.aperture) / 2

  const pose = extractHeadPose(landmarks, result, axisX, iod)

  const faceCentre = mid(rightCentre, leftCentre)

  const feature: GazeFeature = {
    ex,
    ey,
    eyLid,
    vergence,
    aperture,
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    headX: -(faceCentre.x - 0.5),
    headY: faceCentre.y - 0.5,
    headScale: iod,
  }

  return isFeatureFinite(feature) ? feature : null
}

/**
 * Head orientation. Preferred source is MediaPipe's 4x4 facial transformation
 * matrix (column-major); when it is unavailable we fall back to landmark
 * geometry so the pipeline degrades instead of losing the head-pose terms
 * entirely — they are what lets the model stay accurate when the user shifts.
 */
function extractHeadPose(
  landmarks: NormalizedLandmark[],
  result: FaceLandmarkerResult,
  axisX: Vec2,
  iod: number,
): { yaw: number; pitch: number; roll: number } {
  const m = result.facialTransformationMatrixes?.[0]?.data
  if (m && m.length >= 16) {
    // Column-major: element (row, col) lives at m[col * 4 + row].
    const r10 = m[1]
    const r11 = m[5]
    const r02 = m[8]
    const r12 = m[9]
    const r22 = m[10]
    const yaw = -Math.atan2(r02, r22)
    const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)))
    const roll = -Math.atan2(r10, r11)
    if (Number.isFinite(yaw) && Number.isFinite(pitch) && Number.isFinite(roll)) {
      return { yaw, pitch, roll }
    }
  }

  // Landmark fallback: nose displacement from the face midline approximates yaw,
  // nose height between forehead and chin approximates pitch, and the eye axis
  // gives roll directly. Scaled to be roughly radian-like so the ridge model's
  // regularisation treats them on a comparable footing.
  const nose = landmarks[NOSE_TIP]
  const forehead = landmarks[FOREHEAD]
  const chin = landmarks[CHIN]
  const faceMidY = (forehead.y + chin.y) / 2
  const eyeCentreX = (landmarks[RIGHT_EYE_OUTER].x + landmarks[LEFT_EYE_OUTER].x) / 2
  return {
    yaw: -((nose.x - eyeCentreX) / iod),
    pitch: (nose.y - faceMidY) / iod,
    roll: -Math.atan2(axisX.y, axisX.x),
  }
}

/**
 * The face's extent in the frame, as a fraction of frame height.
 *
 * This is the number that decides how much real detail reaches the landmark
 * model. MediaPipe crops the face and resizes that crop to a fixed 256x256
 * before the model runs, so a face smaller than 256px in the source is
 * *upsampled* — the iris is then localised from interpolated pixels, and no
 * amount of extra capture resolution helps, because the limit is how much of
 * the sensor the face occupies rather than how many pixels the sensor has.
 */
export function faceHeightFraction(landmarks: NormalizedLandmark[]): number {
  if (!landmarks || landmarks.length === 0) return 0
  let top = Infinity
  let bottom = -Infinity
  for (const p of landmarks) {
    if (p.y < top) top = p.y
    if (p.y > bottom) bottom = p.y
  }
  const extent = bottom - top
  return Number.isFinite(extent) ? Math.max(0, Math.min(1, extent)) : 0
}

/** Mean eye-blink score, 0 (open) .. 1 (closed), from the blendshape head. */
export function extractBlinkScore(result: FaceLandmarkerResult): number {
  const categories = result.faceBlendshapes?.[0]?.categories
  if (!categories) return 0
  let left = 0
  let right = 0
  for (const c of categories) {
    if (c.categoryName === 'eyeBlinkLeft') left = c.score
    else if (c.categoryName === 'eyeBlinkRight') right = c.score
  }
  return (left + right) / 2
}

/**
 * Per-channel exponential smoothing of the descriptor, applied *before*
 * regression. This matters more than it looks: the calibration basis contains
 * squared and interaction terms, which amplify high-frequency landmark noise, so
 * smoothing only the final cursor cannot undo jitter injected here.
 */
export class FeatureSmoother {
  private state: GazeFeature | null = null

  constructor(private alpha = 0.12) {}

  /** Lower alpha = heavier smoothing (calmer, slightly laggier). */
  configure(alpha: number): void {
    this.alpha = Math.max(0.01, Math.min(1, alpha))
  }

  reset(): void {
    this.state = null
  }

  push(f: GazeFeature): GazeFeature {
    if (!this.state) {
      this.state = { ...f }
      return this.state
    }
    const next = { ...this.state }
    for (const k of FEATURE_KEYS) {
      next[k] = this.state[k] + this.alpha * (f[k] - this.state[k])
    }
    this.state = next
    return next
  }

  get current(): GazeFeature | null {
    return this.state
  }
}
