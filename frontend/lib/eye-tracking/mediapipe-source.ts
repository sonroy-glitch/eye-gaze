import type { FaceLandmarkerResult, FaceLandmarker } from '@mediapipe/tasks-vision'
import {
  extractBlinkScore,
  extractGazeFeature,
  FeatureSmoother,
  isFeatureFinite,
  type GazeFeature,
} from './features'
import type { HeadPose, TrackingIssue } from './types'
import type { BlinkSensitivity, GazeSourceCallbacks } from './webeyetrack-source'

/**
 * Second, independent gaze source: MediaPipe FaceLandmarker iris geometry.
 *
 * This is the pipeline this project ran before WebEyeTrack, restored from git
 * (`features.ts` is unchanged from that version) and re-fitted to the current
 * source interface. It exists because the two estimators fail in completely
 * different ways, and having only one meant a bad day for BlazeGaze was a bad
 * day for the whole product:
 *
 *   - BlazeGaze is a CNN over an eye patch. When it works it needs no geometry,
 *     but when the patch is poor it degrades silently into a near-constant
 *     output, and there is nothing in its interface to tell you that happened.
 *   - This one is explicit geometry: iris centre relative to the eye corners, in
 *     a face-local frame that divides out head roll and camera distance, plus
 *     head yaw/pitch as separate terms. It cannot silently collapse — if the
 *     landmarks are there, the descriptor moves with the eyes — and every step
 *     is inspectable.
 *
 * It is also the same method as the `face-eye-tracker` project (MediaPipe face
 * landmarker, pupil offsets, N-point calibration), which is a Python/OpenCV
 * desktop app and so cannot be used in a browser directly.
 *
 * Everything runs locally: the wasm runtime and the landmark model are served
 * from `/public/mediapipe`, so unlike the WebEyeTrack path this one makes no
 * network requests at all.
 */

/** Blink thresholds, mirroring the WebEyeTrack source so behaviour matches. */
const SENSITIVITY: Record<BlinkSensitivity, { minMs: number; enter: number }> = {
  low: { minMs: 200, enter: 0.65 },
  medium: { minMs: 120, enter: 0.55 },
  high: { minMs: 90, enter: 0.45 },
}
const CLOSURE_EXIT = 0.35
const BLINK_MAX_MS = 900
const BLINK_REFRACTORY_MS = 700
const POST_BLINK_RECOVERY_MS = 260

/**
 * Uncalibrated screen projection of the descriptor.
 *
 * The coefficients are a rough population average, not a personal fit — their
 * only job is to hand the board calibration a signal that already moves in the
 * right direction and at roughly the right scale, so the affine it fits is a
 * modest correction rather than a 20x amplification of noise. The yaw/pitch
 * terms are here rather than left to the calibration because head rotation
 * moves the apparent iris position far more than gaze does, and a point that
 * ignores it would need the calibration to unpick two effects from one number.
 */
function projectFeature(
  feature: GazeFeature,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: width * (0.5 + feature.ex * 4 + feature.yaw * 0.9),
    y: height * (0.5 + feature.ey * 6 + feature.eyLid * 1.2 + feature.pitch * 0.9),
  }
}

/**
 * Which signal drives the pointer.
 *
 * `iris` is gaze: where the eyes are pointing, with the head divided out.
 * `head` ignores the eyes entirely and points with the head instead.
 */
export type GazeProjectionMode = 'iris' | 'head'

/**
 * Head translation contributes this much of the screen per unit of normalised
 * image movement. Small head movements are precise, so this carries most of the
 * fine control.
 */
const HEAD_TRANSLATION_GAIN = 2.2
/**
 * Head rotation contributes the rest. Translation alone would need the player to
 * physically move their head across a wide arc to reach the board edges, which
 * is tiring; rotation extends the range without costing precision near centre.
 */
const HEAD_ROTATION_GAIN = 1.1

/**
 * Head smoothing adapts to how fast the head is moving, instead of being one
 * compromise value.
 *
 * A single constant cannot serve both jobs here. Heavy smoothing (the 0.12 the
 * iris uses) takes ~830ms to converge, so calibration samples land mid-transit
 * and every captured dot is biased toward the previous one. Light smoothing
 * fixes that and settles in ~230ms, but it passes the head's own tremor
 * straight through, and the pointer visibly shakes while aiming. Trading one
 * for the other is what made the pointer jittery.
 *
 * Speed tells the two apart. A head that is barely moving is being held on a
 * target, and wants heavy smoothing. A head in motion is travelling to a new
 * target, and wants a light filter so it arrives and settles quickly. This is
 * the same idea as the One Euro filter already applied downstream, moved up to
 * the feature so the calibration sampler benefits from it too.
 */
const HEAD_ALPHA_STILL = 0.10
const HEAD_ALPHA_MOVING = 0.50
/**
 * Per-frame head movement, in the feature's own units, at which the filter is
 * fully opened up. Deliberate aiming moves well past this; the residual tremor
 * of a held pose sits an order of magnitude below it.
 */
const HEAD_SPEED_REFERENCE = 0.02

/**
 * Uncalibrated screen projection for head pointing.
 *
 * This exists because eye gaze from a webcam tops out at roughly one to three
 * squares of error, which is the whole reason the board has to be selected by
 * halving quarters. The head is a completely different proposition: people aim
 * their head far more precisely than a webcam can infer where their pupils
 * point, and the landmark pipeline measures head position and rotation directly
 * rather than inferring them. Same calibration, same affine fit, same validation
 * error readout, so the two are directly comparable on the number in the panel.
 *
 * Signs follow the iris projection: +yaw and +headX are screen-right in the
 * mirrored view, +pitch and +headY are screen-down.
 */
/**
 * How fast the head is moving between two raw frames, combining translation and
 * rotation the same way the projection does, so "fast" means the same thing to
 * the filter as it does to the pointer on screen.
 */
export function headFeatureSpeed(previous: GazeFeature, current: GazeFeature): number {
  const dx = current.headX - previous.headX
  const dy = current.headY - previous.headY
  const dyaw = current.yaw - previous.yaw
  const dpitch = current.pitch - previous.pitch
  return Math.hypot(dx, dy) * HEAD_TRANSLATION_GAIN + Math.hypot(dyaw, dpitch) * HEAD_ROTATION_GAIN
}

/** Smoothing factor for this frame: heavy when still, light when moving. */
export function headSmoothingAlpha(speed: number): number {
  const t = Math.max(0, Math.min(1, speed / HEAD_SPEED_REFERENCE))
  return HEAD_ALPHA_STILL + (HEAD_ALPHA_MOVING - HEAD_ALPHA_STILL) * t
}

export function projectHeadFeature(
  feature: GazeFeature,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: width * (0.5 + feature.headX * HEAD_TRANSLATION_GAIN + feature.yaw * HEAD_ROTATION_GAIN),
    y: height * (0.5 + feature.headY * HEAD_TRANSLATION_GAIN + feature.pitch * HEAD_ROTATION_GAIN),
  }
}

export class MediaPipeGazeSource {
  private landmarker: FaceLandmarker | null = null
  private readonly video: HTMLVideoElement
  private readonly cb: GazeSourceCallbacks
  private started = false
  private stopped = false
  private rafId = 0
  private lastVideoTime = -1

  /**
   * Head mode gets a much lighter filter than gaze does.
   *
   * 0.12 is tuned for the iris, which jitters constantly from micro-saccades
   * and landmark noise, and it takes roughly 830ms to converge after a step.
   * The head moves in large deliberate arcs instead, so that lag is the
   * dominant error: calibration settles for 220ms and then samples for 550ms,
   * which with the heavy filter is entirely mid-transit, biasing every captured
   * point back toward the previous dot. The head is also inherently steadier,
   * so it does not need the smoothing in the first place, and the One Euro
   * filter downstream still has the final say.
   */
  private readonly smoother = new FeatureSmoother(0.12)
  /** Last unsmoothed feature, for measuring head speed in head mode. */
  private previousRaw: GazeFeature | null = null
  private sensitivity: BlinkSensitivity = 'medium'
  private eyesClosed = false
  private closedSince: number | null = null
  private lastBlinkAt = 0

  private readonly frameTimes: number[] = []
  fps = 0
  cameraResolution: { width: number; height: number } | null = null
  lastResultAt = 0
  lastUsableResultAt = 0
  trackingIssue: TrackingIssue | null = 'model-loading'

  /**
   * This source has no equivalent of WebEyeTrack's click adaptation — the
   * personalisation lives entirely in the board calibration — so the adaptation
   * phase is skipped for it rather than shown as dots that teach nothing.
   */
  readonly ownsAdaptation = false

  /** Whether the pointer follows the eyes or the head. */
  private readonly mode: GazeProjectionMode

  constructor(
    video: HTMLVideoElement,
    callbacks: GazeSourceCallbacks,
    mode: GazeProjectionMode = 'iris',
  ) {
    this.video = video
    this.cb = callbacks
    this.mode = mode
    // Head mode sets its alpha per frame from head speed; this is only the
    // value used for the very first frame, before there is a speed to measure.
    if (mode === 'head') this.smoother.configure(HEAD_ALPHA_MOVING)
  }

  setBlinkSensitivity(sensitivity: BlinkSensitivity): void {
    this.sensitivity = sensitivity
  }

  feedAdaptationPoint(): boolean {
    return false
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.stopped = false

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
    } catch (err) {
      this.started = false
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.cb.onError('Camera permission was denied. Enable it to use gaze control.')
      } else {
        this.cb.onError(err instanceof Error ? err.message : 'Failed to access the camera.')
      }
      return
    }

    try {
      // Client-only: pulls in a wasm runtime, so it must never run during SSR.
      const { FaceLandmarker: Landmarker, FilesetResolver } = await import(
        '@mediapipe/tasks-vision'
      )
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      this.landmarker = await Landmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: '/mediapipe/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })

      this.video.srcObject = stream
      await this.video.play().catch(() => {})
      this.cameraResolution = this.video.videoWidth
        ? { width: this.video.videoWidth, height: this.video.videoHeight }
        : null

      this.trackingIssue = null
      this.loop()
    } catch (err) {
      this.started = false
      stream.getTracks().forEach((t) => t.stop())
      this.cb.onError(
        err instanceof Error ? err.message : 'Failed to load the face landmark model.',
      )
    }
  }

  private loop = (): void => {
    if (this.stopped) return
    this.rafId = requestAnimationFrame(this.loop)

    const video = this.video
    const landmarker = this.landmarker
    if (!landmarker || video.readyState < 2 || video.videoWidth === 0) return
    // detectForVideo rejects a timestamp it has already seen, and the render loop
    // runs faster than the camera delivers frames.
    if (video.currentTime === this.lastVideoTime) return
    this.lastVideoTime = video.currentTime

    const now = performance.now()
    let result: FaceLandmarkerResult
    try {
      result = landmarker.detectForVideo(video, now)
    } catch {
      return
    }
    this.handle(result, now)
  }

  private handle(result: FaceLandmarkerResult, now: number): void {
    const first = this.lastResultAt === 0
    this.lastResultAt = now
    if (first) this.cb.onReady()

    this.frameTimes.push(now)
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift()
    if (this.frameTimes.length > 1) this.fps = this.frameTimes.length

    if (!this.cameraResolution && this.video.videoWidth) {
      this.cameraResolution = { width: this.video.videoWidth, height: this.video.videoHeight }
    }

    const landmarks = result.faceLandmarks?.[0]
    if (!landmarks || landmarks.length === 0) {
      this.trackingIssue = 'no-face'
      this.closedSince = null
      this.eyesClosed = false
      return
    }

    // --- Blink, on the same two-threshold scheme as the other source ---------
    const closure = extractBlinkScore(result)
    const thresholds = SENSITIVITY[this.sensitivity]
    const wasClosed = this.eyesClosed
    this.eyesClosed = wasClosed ? closure > CLOSURE_EXIT : closure >= thresholds.enter
    if (this.eyesClosed && !wasClosed) {
      this.closedSince = now
    } else if (!this.eyesClosed && wasClosed && this.closedSince !== null) {
      const closedFor = now - this.closedSince
      this.closedSince = null
      if (
        closedFor >= thresholds.minMs &&
        closedFor <= BLINK_MAX_MS &&
        now - this.lastBlinkAt >= BLINK_REFRACTORY_MS
      ) {
        this.lastBlinkAt = now
        this.cb.onBlink()
      }
    }

    /*
     * The iris is occluded through a blink, so gaze has no estimate to make.
     * Head pointing is unaffected: the face is still fully visible with the eyes
     * shut, and dropping the point would make the pointer jump away at exactly
     * the moment a blink-to-confirm needs it to hold still.
     */
    const blinkBlindsPointer = this.mode === 'iris'
    this.trackingIssue = this.eyesClosed && blinkBlindsPointer ? 'low-confidence' : null
    if (this.eyesClosed && blinkBlindsPointer) return

    const raw = extractGazeFeature(landmarks, result)
    if (!raw || !isFeatureFinite(raw)) {
      this.trackingIssue = 'low-confidence'
      return
    }

    // Head mode retunes the filter every frame from how fast the head is
    // actually moving, so a held pose is smoothed hard and a travelling one
    // barely at all. See the constants for why one fixed value cannot do both.
    if (this.mode === 'head') {
      if (this.previousRaw) {
        this.smoother.configure(headSmoothingAlpha(headFeatureSpeed(this.previousRaw, raw)))
      }
      this.previousRaw = raw
    }

    const feature = this.smoother.push(raw)
    if (!feature) return

    this.lastUsableResultAt = now
    const point =
      this.mode === 'head'
        ? projectHeadFeature(feature, window.innerWidth, window.innerHeight)
        : projectFeature(feature, window.innerWidth, window.innerHeight)

    // Head pose straight from the descriptor, in the same shape the calibration
    // model stores for drift detection. `headScale` is inter-ocular distance in
    // normalised image units, so its reciprocal stands in for distance.
    const head: HeadPose = {
      origin: [feature.headX, feature.headY, feature.headScale > 0 ? 1 / feature.headScale : 0],
      vector: [feature.yaw, feature.pitch, feature.roll],
    }

    const sinceBlink = now - this.lastBlinkAt
    const recovery =
      sinceBlink >= POST_BLINK_RECOVERY_MS
        ? 1
        : 0.3 + 0.7 * Math.max(0, sinceBlink / POST_BLINK_RECOVERY_MS)
    const openness = 1 - 0.85 * Math.max(0, Math.min(1, (closure - 0.2) / 0.35))

    /*
     * Eye closure says nothing about how well the head is being tracked, so in
     * head mode confidence stays on the landmarks alone. Scoring it by openness
     * would make the pointer "lose confidence" every time the player blinks,
     * which the dwell would then read as an unusable frame.
     */
    const confidence =
      this.mode === 'head' ? 0.9 : Math.max(0.05, Math.min(1, openness * recovery))

    this.cb.onFrame({
      point: {
        x: point.x,
        y: point.y,
        confidence,
      },
      head,
      eyeClosure: closure,
      faceLost: false,
    })
  }

  msSinceLastResult(now = performance.now()): number {
    return this.lastResultAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastResultAt
  }

  msSinceLastUsableResult(now = performance.now()): number {
    return this.lastUsableResultAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastUsableResultAt
  }

  stop(): void {
    this.stopped = true
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    try {
      const stream = this.video.srcObject as MediaStream | null
      stream?.getTracks().forEach((track) => track.stop())
      this.video.srcObject = null
    } catch {
      // Best-effort teardown.
    }
    this.landmarker?.close()
    this.landmarker = null
    this.started = false
    this.lastResultAt = 0
    this.lastUsableResultAt = 0
    this.smoother.reset()
    this.previousRaw = null
    this.eyesClosed = false
    this.closedSince = null
    this.trackingIssue = 'model-loading'
  }
}
