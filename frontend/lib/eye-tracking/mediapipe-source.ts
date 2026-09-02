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

export class MediaPipeGazeSource {
  private landmarker: FaceLandmarker | null = null
  private readonly video: HTMLVideoElement
  private readonly cb: GazeSourceCallbacks
  private started = false
  private stopped = false
  private rafId = 0
  private lastVideoTime = -1

  private readonly smoother = new FeatureSmoother(0.12)
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

  constructor(video: HTMLVideoElement, callbacks: GazeSourceCallbacks) {
    this.video = video
    this.cb = callbacks
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

    this.trackingIssue = this.eyesClosed ? 'low-confidence' : null
    // The iris is occluded through a blink, so there is no estimate to make.
    if (this.eyesClosed) return

    const raw = extractGazeFeature(landmarks, result)
    if (!raw || !isFeatureFinite(raw)) {
      this.trackingIssue = 'low-confidence'
      return
    }
    const feature = this.smoother.push(raw)
    if (!feature) return

    this.lastUsableResultAt = now
    const point = projectFeature(feature, window.innerWidth, window.innerHeight)

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

    this.cb.onFrame({
      point: {
        x: point.x,
        y: point.y,
        confidence: Math.max(0.05, Math.min(1, openness * recovery)),
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
    this.eyesClosed = false
    this.closedSince = null
    this.trackingIssue = 'model-loading'
  }
}
