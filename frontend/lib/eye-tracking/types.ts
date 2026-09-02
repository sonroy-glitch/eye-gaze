export interface GazePoint {
  x: number
  y: number
  confidence: number
}

/**
 * Where the head is, as WebEyeTrack's face reconstruction reports it:
 * `origin` is the 3D face origin in camera space (roughly centimetres) and
 * `vector` is the head direction. Both are inputs to the BlazeGaze CNN, so the
 * gaze estimate is only valid near the pose it was calibrated at — which is why
 * the calibration model stores the pose it was fitted under.
 */
export interface HeadPose {
  origin: [number, number, number]
  vector: [number, number, number]
}

/** One tracker frame, with everything we can learn about how much to trust it. */
export interface GazeFrame {
  point: GazePoint
  head: HeadPose | null
  /** 0..1 how shut the eyes are this frame (blendshape-derived when available). */
  eyeClosure: number
  /** No face in frame at all — distinct from eyes deliberately closed. */
  faceLost: boolean
}

export type TrackingStatus = 'inactive' | 'calibrating' | 'active' | 'lost'
export type TrackingIssue =
  | 'camera-denied'
  | 'camera-unavailable'
  | 'model-loading'
  | 'webeyetrack-not-initialized'
  | 'no-face'
  | 'calibration-incomplete'
  | 'low-confidence'
  | 'board-too-small'
  /** The head has moved well away from where calibration was collected. */
  | 'head-moved'

export interface EyeTrackingState {
  status: TrackingStatus
  /** Raw WebEyeTrack point converted from normPog to viewport CSS pixels. */
  rawGazePoint: GazePoint
  /** Personalized board-corrected point in viewport CSS pixels. */
  correctedGazePoint: GazePoint
  /** Backward-compatible alias for the corrected point used by the UI cursor. */
  gazePoint: GazePoint
  blinkDetected: boolean
  calibrationProgress: number
  isCalibrated: boolean
  calibrationQuality: number
  calibrationErrorSquares: number | null
  trackingIssue: TrackingIssue | null
  cameraPermission: 'granted' | 'denied' | 'prompt'
  /**
   * 0 = the head is where it was at calibration, 1 = far enough away that the
   * mapping should no longer be trusted. Null when either pose is unknown.
   */
  headDrift: number | null
}

export interface AccessibilitySettings {
  /** How long the gaze must hold a square before it selects, 500..800ms. */
  dwellTime: number
  /** Cursor smoothing/stability, 0 (responsive) .. 100 (very steady). */
  smoothing: number
  blinkSensitivity: 'low' | 'medium' | 'high'
  highContrast: boolean
  largeCursor: boolean
  reducedMotion: boolean
  voiceFeedback: boolean
}

/**
 * Which raw gaze estimator is driving the board.
 *
 * Two independent implementations are kept because they fail differently: the
 * CNN can collapse to a near-constant output with nothing in its interface to
 * say so, while the landmark pipeline can only fail loudly (no face, no
 * descriptor). Whichever one is having a bad day on a given machine, camera or
 * face, the other is usually fine — and switching is a keypress rather than a
 * rebuild.
 */
export type GazeSourceKind = 'webeyetrack' | 'mediapipe'

export const GAZE_SOURCE_LABELS: Record<GazeSourceKind, string> = {
  webeyetrack: 'BlazeGaze CNN',
  mediapipe: 'MediaPipe iris',
}

/** Everything `useGazeTracking` needs from a raw source, whichever it is. */
export interface GazeSourceLike {
  start(): Promise<void>
  stop(): void
  setBlinkSensitivity(sensitivity: 'low' | 'medium' | 'high'): void
  feedAdaptationPoint(x: number, y: number): boolean
  readonly ownsAdaptation: boolean
  fps: number
  cameraResolution: { width: number; height: number } | null
  trackingIssue: TrackingIssue | null
  msSinceLastResult(now?: number): number
  msSinceLastUsableResult(now?: number): number
}
