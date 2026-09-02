import type { GazeFrame, GazePoint, HeadPose, TrackingIssue } from './types'

/**
 * Thin wrapper around the WebEyeTrack package (`webeyetrack`), which replaces the
 * old MediaPipe + ridge-regression pipeline as the raw gaze source.
 *
 * WebEyeTrack runs its own MediaPipe FaceLandmarker + BlazeGaze CNN inside a Web
 * Worker (bundled as an inline blob, so no separate worker file is served). The
 * proxy owns the camera: constructing it starts the worker, and once the worker
 * signals ready the proxy calls `WebcamClient.startWebcam` itself and begins
 * emitting gaze results.
 *
 * What this wrapper adds on top of the raw stream:
 *   - normalised point-of-gaze (`normPog`, centred [-0.5..0.5]) -> viewport pixels
 *   - deliberate-blink detection that can tell a blink from a lost face
 *   - a real per-frame confidence, from eye openness and head steadiness
 *   - head pose, so the calibration model can know the pose it was fitted at
 *   - ownership of the library's click-driven adaptation (see below)
 *
 * Frames never leave the device; only the model files are fetched (the BlazeGaze
 * weights from our own `/web`, MediaPipe wasm + face model from CDN on first load).
 */

/** A deliberate blink is eyes closed for at least this long (ms)... */
const BLINK_MIN_MS = 120
/** ...but not longer than this (avoids treating resting-closed eyes as a blink). */
const BLINK_MAX_MS = 900
/** Minimum gap between accepted blinks (ms), to debounce confirm actions. */
const BLINK_REFRACTORY_MS = 700

/**
 * Eye-closure hysteresis, on the 0..1 blendshape scale. Two thresholds rather
 * than one: a single threshold sitting near a half-closed eyelid chatters
 * open/closed many times a second, and every one of those transitions is a
 * candidate blink.
 */
const CLOSURE_ENTER = 0.55
const CLOSURE_EXIT = 0.35

/**
 * How much a frame's confidence is cut while the eyelids are on their way down
 * or up. The pupil is partly occluded well before the eye reads as "closed", and
 * those frames are where the estimate throws itself across the board.
 */
const CLOSURE_PENALTY_START = 0.2
const CLOSURE_PENALTY_END = 0.55

/** Recovery ramp after a blink, during which the estimate is not yet trusted. */
const POST_BLINK_RECOVERY_MS = 260

/** Head speed (cm/s) at which a frame's confidence is halved. */
const HEAD_SPEED_HALF_CONFIDENCE = 12

export type BlinkSensitivity = 'low' | 'medium' | 'high'

/**
 * Per-sensitivity blink thresholds. "Low" wants a long, unmistakable close (few
 * false confirms, some missed blinks); "high" accepts a shorter, lighter one.
 */
const SENSITIVITY: Record<BlinkSensitivity, { minMs: number; enter: number }> = {
  low: { minMs: 200, enter: 0.65 },
  medium: { minMs: BLINK_MIN_MS, enter: CLOSURE_ENTER },
  high: { minMs: 90, enter: 0.45 },
}

/** Only the fields of WebEyeTrack's GazeResult we actually consume. */
interface GazeResultLike {
  normPog: number[]
  gazeState: 'open' | 'closed'
  facialLandmarks?: unknown[]
  faceBlendshapes?: Array<{ categories?: Array<{ categoryName?: string; score?: number }> }>
  headVector?: number[]
  faceOrigin3D?: number[]
  timestamp: number
}

export interface GazeSourceCallbacks {
  /** A new gaze frame, eyes open and face present. */
  onFrame: (frame: GazeFrame) => void
  /** A deliberate blink was detected. */
  onBlink: () => void
  /** First gaze result landed — worker + models are up and frames are flowing. */
  onReady: () => void
  /** Fatal error bringing the source up (camera denied, model load failed). */
  onError: (message: string) => void
}

function readBlendshapeClosure(r: GazeResultLike): number | null {
  const categories = r.faceBlendshapes?.[0]?.categories
  if (!Array.isArray(categories) || categories.length === 0) return null
  let left: number | null = null
  let right: number | null = null
  for (const category of categories) {
    if (category?.categoryName === 'eyeBlinkLeft' && typeof category.score === 'number') {
      left = category.score
    } else if (category?.categoryName === 'eyeBlinkRight' && typeof category.score === 'number') {
      right = category.score
    }
  }
  if (left === null && right === null) return null
  // The *lower* of the two: a genuine blink shuts both eyes, whereas a single
  // high score is usually a landmark glitch on one side or a wink, neither of
  // which should be able to commit a move.
  return Math.min(left ?? 1, right ?? 1)
}

function readTriple(values: number[] | undefined): [number, number, number] | null {
  if (!Array.isArray(values) || values.length < 3) return null
  const [a, b, c] = values
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
  return [a, b, c]
}

export class WebEyeTrackSource {
  private proxy: { onGazeResults: (r: GazeResultLike) => void } | null = null
  private webcamClient: { stopWebcam?: () => void } | null = null
  private readonly video: HTMLVideoElement
  private readonly cb: GazeSourceCallbacks
  private started = false

  // Blink detection over the eye-closure stream.
  private closedSince: number | null = null
  private lastBlinkAt = 0
  private eyesClosed = false
  private sensitivity: BlinkSensitivity = 'medium'

  // Head motion, for the per-frame confidence.
  private lastHead: HeadPose | null = null
  private lastHeadAt = 0
  private headSpeed = 0

  // Throughput + framing, surfaced to the status panel.
  private readonly frameTimes: number[] = []
  fps = 0
  cameraResolution: { width: number; height: number } | null = null
  /** performance.now() of the most recent gaze result; 0 before the first. */
  lastResultAt = 0
  /** performance.now() of the most recent open-eye, face-present result. */
  lastUsableResultAt = 0
  trackingIssue: TrackingIssue | null = 'model-loading'

  /**
   * The library's own window click listener, taken over at construction.
   *
   * WebEyeTrack adapts on every click anywhere in the page: `handleClick` feeds
   * the current eye patch to `adapt()`, which refits an internal 2x3 affine from
   * its last five click points and applies it to `normPog` from then on. The
   * cursor is treated as ground truth for where the eyes were.
   *
   * That is a problem for us in both directions. During play it means every
   * mouse move silently refits the base that our own calibration model was
   * fitted *on top of*, so a calibration decays as the game goes on — the
   * "it followed my eyes at first and then stopped" failure. And during
   * calibration it never fires at all, because the overlay has to swallow clicks
   * to stop the same poisoning, so the library's adaptation is left at its
   * factory state and does no personalisation whatsoever.
   *
   * So we intercept the listener at construction and never let the page reach
   * it. Instead {@link feedAdaptationPoint} calls it deliberately, with a point
   * we know the user was actually looking at (a calibration dot they held their
   * gaze on). After calibration nothing feeds it, so the base stays put and our
   * model stays valid for the whole session.
   */
  private adaptationListeners: Array<(event: MouseEvent) => void> = []
  private lastAdaptationAt = 0
  private lastAdaptationPoint: { x: number; y: number } | null = null

  constructor(video: HTMLVideoElement, callbacks: GazeSourceCallbacks) {
    this.video = video
    this.cb = callbacks
  }

  /** True when we successfully took over the library's click adaptation. */
  get ownsAdaptation(): boolean {
    return this.adaptationListeners.length > 0
  }

  setBlinkSensitivity(sensitivity: BlinkSensitivity): void {
    this.sensitivity = sensitivity
  }

  /**
   * Hand WebEyeTrack one look-aligned ground-truth point, in viewport pixels.
   *
   * Returns false when the library would reject it anyway: `handleClick` drops
   * anything within 1s or 0.05 normalised units of the previous point, and we
   * would rather the caller know the sample was not taken than believe the
   * model learned something it did not.
   */
  feedAdaptationPoint(x: number, y: number): boolean {
    if (!this.ownsAdaptation) return false
    const now = performance.now()
    if (now - this.lastAdaptationAt < ADAPTATION_MIN_GAP_MS) return false

    const nx = x / window.innerWidth - 0.5
    const ny = y / window.innerHeight - 0.5
    const previous = this.lastAdaptationPoint
    if (
      previous &&
      Math.abs(nx - previous.x) < ADAPTATION_MIN_SEPARATION &&
      Math.abs(ny - previous.y) < ADAPTATION_MIN_SEPARATION
    ) {
      return false
    }

    this.lastAdaptationAt = now
    this.lastAdaptationPoint = { x: nx, y: ny }
    // The listener only ever reads clientX/clientY off the event.
    const event = { clientX: x, clientY: y } as MouseEvent
    for (const listener of this.adaptationListeners) listener(event)
    return true
  }

  /**
   * Bring the source up. Idempotent. Pre-flights camera permission so a denial is
   * reported cleanly (WebEyeTrack's own getUserMedia happens deep inside the
   * worker's ready handler, where a rejection would otherwise be swallowed).
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // WebcamClient addresses the video element by id.
    if (!this.video.id) this.video.id = 'webeyetrack-webcam'

    // Pre-flight the camera: surfaces NotAllowedError as a real error, and pre-
    // grants permission so WebcamClient's own getUserMedia resolves immediately.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      })
      probe.getTracks().forEach((t) => t.stop())
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
      // Client-only: the package pulls in TF.js and a Web Worker, so it must never
      // be evaluated during SSR. Dynamic import keeps it out of the server bundle.
      const mod = await import('webeyetrack')
      const { WebcamClient, WebEyeTrackProxy } = mod
      this.webcamClient = new WebcamClient(this.video.id) as { stopWebcam?: () => void }

      // The proxy registers its window click listener synchronously inside this
      // constructor, so a temporary patch around exactly this call captures it
      // and nothing else. Restored in `finally` even if construction throws.
      const capturedListeners: Array<(event: MouseEvent) => void> = []
      const originalAddEventListener = window.addEventListener
      window.addEventListener = function patchedAddEventListener(
        this: Window,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === 'click' && typeof listener === 'function') {
          capturedListeners.push(listener as (event: MouseEvent) => void)
          return
        }
        return originalAddEventListener.call(
          this,
          type,
          listener as EventListenerOrEventListenerObject,
          options,
        )
      } as typeof window.addEventListener

      let proxy: unknown
      try {
        proxy = new WebEyeTrackProxy(
          this.webcamClient as unknown as ConstructorParameters<typeof WebEyeTrackProxy>[0],
        )
      } finally {
        window.addEventListener = originalAddEventListener
      }
      this.adaptationListeners = capturedListeners

      const typedProxy = proxy as { onGazeResults: (r: GazeResultLike) => void }
      typedProxy.onGazeResults = (r: GazeResultLike) => this.handle(r)
      this.proxy = typedProxy
    } catch (err) {
      this.started = false
      this.cb.onError(err instanceof Error ? err.message : 'Failed to start eye tracking.')
    }
  }

  private handle(r: GazeResultLike): void {
    const now = performance.now()
    const first = this.lastResultAt === 0
    this.lastResultAt = now
    if (first) this.cb.onReady()

    // Rolling one-second frame rate.
    this.frameTimes.push(now)
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift()
    if (this.frameTimes.length > 1) this.fps = this.frameTimes.length

    if (!this.cameraResolution && this.video.videoWidth) {
      this.cameraResolution = { width: this.video.videoWidth, height: this.video.videoHeight }
    }

    // --- Face presence and eye closure -------------------------------------
    //
    // These are two different things and the old code conflated them: a lost
    // face was treated as closed eyes, so any 120-900ms tracking dropout (a hand
    // passing the camera, a lighting change, a head turn) was scored as a
    // deliberate blink and confirmed whatever square happened to be selected.
    // Pieces moved on their own. A lost face now cancels the blink outright.
    const hasFace = !Array.isArray(r.facialLandmarks) || r.facialLandmarks.length > 0
    const faceLost = !hasFace

    const thresholds = SENSITIVITY[this.sensitivity]
    const blendshapeClosure = readBlendshapeClosure(r)
    // Fall back to the library's own open/closed flag when blendshapes are not
    // being delivered. It is coarser (it fires when *either* eye's aspect ratio
    // drops below 0.2, so a squint or a one-sided landmark glitch counts) which
    // is exactly why it is the fallback rather than the primary signal.
    const closure = blendshapeClosure ?? (r.gazeState === 'closed' ? 1 : 0)

    if (faceLost) {
      this.closedSince = null
      this.eyesClosed = false
      this.trackingIssue = 'no-face'
    } else {
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
    }

    // --- Head pose and how fast it is moving --------------------------------
    const origin = readTriple(r.faceOrigin3D)
    const vector = readTriple(r.headVector)
    const head: HeadPose | null = origin && vector ? { origin, vector } : null
    if (head && this.lastHead && now > this.lastHeadAt) {
      const dt = Math.max(1, now - this.lastHeadAt) / 1000
      const moved = Math.hypot(
        head.origin[0] - this.lastHead.origin[0],
        head.origin[1] - this.lastHead.origin[1],
        head.origin[2] - this.lastHead.origin[2],
      )
      // Light EMA: a single noisy reconstruction should not read as a lunge.
      this.headSpeed = this.headSpeed * 0.7 + (moved / dt) * 0.3
    }
    if (head) {
      this.lastHead = head
      this.lastHeadAt = now
    }

    /*
     * Whether this frame carries a real estimate at all — a strictly separate
     * question from whether the player blinked, and conflating the two is
     * expensive in both directions.
     *
     * `gazeState` is the library's own verdict, and when it says "closed" it
     * does not run BlazeGaze at all: it returns `normPog: [0, 0]`, which maps to
     * the exact centre of the screen. Its test is EAR < 0.2 on *either* eye,
     * which is far more trigger-happy than the blendshape blink score — narrow
     * eye apertures, glasses, and looking down all trip it while the blendshapes
     * still read as open. So a frame the library refused to estimate must be
     * dropped on the library's say-so, not on ours, whatever our own blink
     * detector thinks.
     *
     * Getting this wrong is not a small error. Those [0, 0] frames sail through
     * as a confident gaze point at the centre of the board, they outnumber the
     * real ones, and the calibration's robust median over each target lands on
     * the centre for every dot. The regression then has nothing to learn from
     * and can only fit "predict the average target", which scores almost exactly
     * 3.4 squares of validation error whatever the player does — the fixed,
     * unimprovable number that is the signature of this bug rather than of a bad
     * webcam. `npm run verify:gaze` asserts that signature so it stays caught.
     */
    const sentinelPog = r.normPog?.[0] === 0 && r.normPog?.[1] === 0
    if (faceLost || this.eyesClosed || r.gazeState === 'closed' || sentinelPog) return
    if (!Array.isArray(r.normPog) || r.normPog.length < 2) return
    if (!Number.isFinite(r.normPog[0]) || !Number.isFinite(r.normPog[1])) return

    this.lastUsableResultAt = now
    const px = (r.normPog[0] + 0.5) * window.innerWidth
    const py = (r.normPog[1] + 0.5) * window.innerHeight

    this.cb.onFrame({
      point: { x: px, y: py, confidence: this.frameConfidence(now, closure) },
      head,
      eyeClosure: closure,
      faceLost: false,
    })
  }

  /**
   * How much this frame is worth as evidence, 0..1.
   *
   * This used to be the constant 0.9, which quietly disabled the stabiliser's
   * whole weighting stage — a frame caught mid-blink with a half-occluded pupil
   * voted exactly as hard as a clean one. The three things that actually predict
   * a bad estimate are multiplied together, so any one of them being bad is
   * enough to discount the frame.
   */
  private frameConfidence(now: number, closure: number): number {
    // 1. Eyelid position. Well before an eye reads as "closed" the pupil is
    //    partly covered and the estimate starts sliding.
    const closureSpan = CLOSURE_PENALTY_END - CLOSURE_PENALTY_START
    const closurePenalty = Math.max(
      0,
      Math.min(1, (closure - CLOSURE_PENALTY_START) / closureSpan),
    )
    const openness = 1 - 0.85 * closurePenalty

    // 2. Recovery after a blink: the first frames back are the least reliable.
    const sinceBlink = now - this.lastBlinkAt
    const recovery =
      sinceBlink >= POST_BLINK_RECOVERY_MS
        ? 1
        : 0.3 + 0.7 * Math.max(0, sinceBlink / POST_BLINK_RECOVERY_MS)

    // 3. Head motion. BlazeGaze takes head pose as an input, so while the head
    //    is actually moving the estimate is chasing a pose that has already
    //    changed.
    const steadiness = 1 / (1 + this.headSpeed / HEAD_SPEED_HALF_CONFIDENCE)

    return Math.max(0.05, Math.min(1, openness * recovery * steadiness))
  }

  /** How long since the last gaze result; used to flag a lost signal. */
  msSinceLastResult(now = performance.now()): number {
    return this.lastResultAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastResultAt
  }

  /** How long since the last face-present, open-eye gaze result. */
  msSinceLastUsableResult(now = performance.now()): number {
    return this.lastUsableResultAt === 0 ? Number.POSITIVE_INFINITY : now - this.lastUsableResultAt
  }

  /** Full teardown — call on page unmount only (see class note on lifetime). */
  stop(): void {
    if (this.proxy) this.proxy.onGazeResults = () => {}
    try {
      this.webcamClient?.stopWebcam?.()
    } catch {
      // Best-effort; the stream stops when its tracks are GC'd regardless.
    }
    this.proxy = null
    this.webcamClient = null
    this.adaptationListeners = []
    this.started = false
    this.lastResultAt = 0
    this.lastUsableResultAt = 0
    this.trackingIssue = 'model-loading'
    this.closedSince = null
    this.eyesClosed = false
    this.lastHead = null
    this.headSpeed = 0
  }
}

/** WebEyeTrack's own click debounce is 1s; leave a margin over it. */
const ADAPTATION_MIN_GAP_MS = 1100
/** ...and it drops points within 0.05 normalised units of the previous one. */
const ADAPTATION_MIN_SEPARATION = 0.06

export type { GazePoint }
