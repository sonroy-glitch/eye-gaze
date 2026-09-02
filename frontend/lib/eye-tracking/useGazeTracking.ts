'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { WebEyeTrackSource, type BlinkSensitivity } from './webeyetrack-source'
import { MediaPipeGazeSource } from './mediapipe-source'
import { OneEuroFilter2D, smoothingToMinCutoff } from './one-euro'
import type {
  EyeTrackingState,
  GazeFrame,
  GazePoint,
  GazeSourceKind,
  GazeSourceLike,
  HeadPose,
  TrackingStatus,
} from './types'
import {
  applyCalibrationModel,
  headDriftScore,
  isLowQualityModel,
  clearCalibrationModel,
  loadCalibrationModel,
  saveCalibrationModel,
  CALIBRATION_TARGETS,
  type CalibrationModel,
} from './calibration-model'
import { getBoardFrameRect, remapForBoard } from './board-mapping'

/** No gaze result for this long (ms) flips status to "lost". */
const FACE_LOST_MS = 1000

/**
 * Board-specific gaze samples needed before square selection is trusted. Fewer
 * points cannot fit a stable chessboard correction over all 64 squares.
 */
const MIN_CALIBRATION_SAMPLES = CALIBRATION_TARGETS.length
const STATE_COMMIT_MS = 50

/** Where the chosen estimator is remembered between visits. */
const SOURCE_STORAGE_KEY = 'armaan.chess.gazeSource.v1'

/**
 * If the chosen source has produced no usable frame this long after coming up,
 * it is not going to. Rather than leave the player staring at a dead board we
 * fall back to the other estimator automatically and say so. Generous enough to
 * cover a cold model load on a slow machine.
 */
const SOURCE_FALLBACK_MS = 9000

function loadPreferredSource(): GazeSourceKind {
  if (typeof window === 'undefined') return DEFAULT_GAZE_SOURCE
  const stored = window.localStorage.getItem(SOURCE_STORAGE_KEY)
  return stored === 'webeyetrack' || stored === 'mediapipe' ? stored : DEFAULT_GAZE_SOURCE
}

/**
 * The landmark pipeline is the default. It is the one whose every step can be
 * inspected, it self-hosts its model so it works with no network, and it cannot
 * degrade into a confident-looking constant the way an eye-patch CNN can.
 */
export const DEFAULT_GAZE_SOURCE: GazeSourceKind = 'mediapipe'

export interface UseGazeTracking {
  /** Attach to the hidden <video id="webcam"> WebEyeTrack drives. */
  videoRef: React.RefObject<HTMLVideoElement | null>
  state: EyeTrackingState
  /** True once the worker + models are up and gaze results are flowing. */
  isReady: boolean
  error: string | null
  /** True once a persisted or newly collected board calibration model exists. */
  hasCalibration: boolean
  calibrationModel: CalibrationModel | null
  /** How many calibration samples have been collected this session. */
  calibrationSampleCount: number
  rawGazePointRef: React.RefObject<GazePoint>
  /** What the camera actually delivered, once known. */
  cameraResolution: { width: number; height: number } | null
  /** Detection throughput (gaze results per second). */
  fps: number
  /** Request camera + start WebEyeTrack. Idempotent. */
  start: () => Promise<void>
  /** Record one collected calibration sample for progress-only callers. */
  noteCalibrationSample: () => void
  /** Persist a completed chessboard calibration correction model. */
  setCalibrationModel: (model: CalibrationModel) => void
  /** Forget this session's collected samples (the UI's calibration gate). */
  resetCalibration: () => void
  /** Subscribe to deliberate-blink events. Returns an unsubscribe fn. */
  onBlink: (cb: () => void) => () => void
  /** Set cursor smoothing strength, 0 (responsive) .. 1 (very steady). */
  setSmoothing: (strength: number) => void
  /** How hard a blink has to be before it counts as a confirm. */
  setBlinkSensitivity: (sensitivity: BlinkSensitivity) => void
  /**
   * Teach the tracker's own on-device model one point the user was demonstrably
   * looking at, in viewport pixels. Returns false when the library declined it
   * (it drops points inside 1s or 0.05 normalised units of the previous one).
   * Calibration only — see `feedAdaptationPoint` in the source for why.
   */
  feedAdaptationPoint: (x: number, y: number) => boolean
  /**
   * Whether we hold the library's click-adaptation hook. False means the package
   * changed shape under us and the adaptation phase must be skipped rather than
   * shown as a row of dots that teach nothing.
   */
  ownsAdaptationRef: React.RefObject<boolean>
  /** Live head pose, so calibration can record the pose it was fitted at. */
  headPoseRef: React.RefObject<HeadPose | null>
  /** 0..1+ how far the head has moved since calibration; null when unknown. */
  headDrift: number | null
  /** Which estimator is currently driving the board. */
  sourceKind: GazeSourceKind
  /** Swap estimators; each keeps its own calibration. */
  switchSource: (kind: GazeSourceKind) => Promise<void>
  /** True when the swap was made automatically because the first one was dead. */
  autoSwitched: boolean
}

export function useGazeTracking(): UseGazeTracking {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sourceRef = useRef<GazeSourceLike | null>(null)
  /** Which estimator is active. Persisted, so a working choice survives a reload. */
  const [sourceKind, setSourceKindState] = useState<GazeSourceKind>(DEFAULT_GAZE_SOURCE)
  const sourceKindRef = useRef<GazeSourceKind>(DEFAULT_GAZE_SOURCE)
  sourceKindRef.current = sourceKind
  /** Set when we switched estimators on the player's behalf, for the UI to explain. */
  const [autoSwitched, setAutoSwitched] = useState(false)

  // Read the stored preference on the client only; the server has no localStorage
  // and guessing here would flip the source on hydration.
  useEffect(() => {
    setSourceKindState(loadPreferredSource())
  }, [])
  const startedRef = useRef(false)
  const calibrationModelRef = useRef<CalibrationModel | null>(null)
  const calibrationSampleCountRef = useRef(0)
  const smoothingStrengthRef = useRef(0.7)
  const blinkSensitivityRef = useRef<BlinkSensitivity>('medium')
  const rawGazePointRef = useRef<GazePoint>({ x: 0, y: 0, confidence: 0 })
  const correctedGazePointRef = useRef<GazePoint>({ x: 0, y: 0, confidence: 0 })
  /**
   * Velocity-adaptive smoothing. Replaces the fixed-alpha EMA, which had to pick
   * one compromise between jitter while fixating and lag across a saccade; see
   * `one-euro.ts` for why that trade is avoidable.
   */
  const filterRef = useRef<OneEuroFilter2D | null>(null)
  if (!filterRef.current) {
    filterRef.current = new OneEuroFilter2D({ minCutoff: smoothingToMinCutoff(0.7) })
  }
  /** Latest head pose, for drift against the pose the model was fitted at. */
  const headRef = useRef<HeadPose | null>(null)
  const headDriftRef = useRef<number | null>(null)
  const ownsAdaptationRef = useRef(false)
  const lastStateCommitAtRef = useRef(0)

  const blinkSubscribers = useRef<Set<() => void>>(new Set())

  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [calibrationModel, setCalibrationModelState] = useState<CalibrationModel | null>(null)
  const [calibrationSampleCount, setCalibrationSampleCount] = useState(0)
  const [cameraResolution, setCameraResolution] = useState<{
    width: number
    height: number
  } | null>(null)
  const [fps, setFps] = useState(0)
  const [state, setState] = useState<EyeTrackingState>({
    status: 'inactive',
    rawGazePoint: rawGazePointRef.current,
    correctedGazePoint: correctedGazePointRef.current,
    gazePoint: { x: 0, y: 0, confidence: 0 },
    blinkDetected: false,
    calibrationProgress: 0,
    isCalibrated: false,
    calibrationQuality: 0,
    calibrationErrorSquares: null,
    trackingIssue: 'webeyetrack-not-initialized',
    cameraPermission: 'prompt',
    headDrift: null,
  })

  useEffect(() => {
    const stored = loadCalibrationModel(sourceKind)
    if (!stored) {
      // Switching to a source that has never been calibrated must clear the
      // other one's model, not keep applying it to a different raw stream.
      calibrationModelRef.current = null
      setCalibrationModelState(null)
      setCalibrationSampleCount(0)
      setState((prev) => ({
        ...prev,
        isCalibrated: false,
        calibrationProgress: 0,
        calibrationQuality: 0,
        calibrationErrorSquares: null,
        trackingIssue: 'calibration-incomplete',
      }))
      return
    }
    calibrationModelRef.current = stored
    calibrationSampleCountRef.current = stored.sampleCount
    setCalibrationModelState(stored)
    setCalibrationSampleCount(stored.sampleCount)
    setState((prev) => ({
      ...prev,
      isCalibrated: true,
      calibrationProgress: 100,
      calibrationQuality: stored.qualityScore,
      calibrationErrorSquares: stored.validationErrorSquares,
      trackingIssue: isLowQualityModel(stored) ? 'low-confidence' : prev.trackingIssue,
    }))
  }, [sourceKind])

  const onBlink = useCallback((cb: () => void) => {
    blinkSubscribers.current.add(cb)
    return () => {
      blinkSubscribers.current.delete(cb)
    }
  }, [])

  const noteCalibrationSample = useCallback(() => {
    setCalibrationSampleCount((n) => {
      const next = n + 1
      calibrationSampleCountRef.current = next
      return next
    })
  }, [])

  const setCalibrationModel = useCallback((model: CalibrationModel) => {
    calibrationModelRef.current = model
    calibrationSampleCountRef.current = model.sampleCount
    filterRef.current?.reset()
    saveCalibrationModel(model, sourceKindRef.current)
    setCalibrationModelState(model)
    setCalibrationSampleCount(model.sampleCount)
    setState((prev) => ({
      ...prev,
      isCalibrated: true,
      calibrationProgress: 100,
      calibrationQuality: model.qualityScore,
      calibrationErrorSquares: model.validationErrorSquares,
      // Only a calibration past the module's own reject line is a warning; a
      // pass-but-not-perfect fit is the normal case for a webcam tracker.
      trackingIssue: isLowQualityModel(model) ? 'low-confidence' : null,
    }))
  }, [])

  const resetCalibration = useCallback(() => {
    clearCalibrationModel(sourceKindRef.current)
    calibrationModelRef.current = null
    calibrationSampleCountRef.current = 0
    filterRef.current?.reset()
    setCalibrationModelState(null)
    setCalibrationSampleCount(0)
    setState((prev) => ({
      ...prev,
      isCalibrated: false,
      calibrationProgress: 0,
      calibrationQuality: 0,
      calibrationErrorSquares: null,
      trackingIssue: 'calibration-incomplete',
    }))
  }, [])

  const setSmoothing = useCallback((strength: number) => {
    const clamped = Math.max(0, Math.min(1, strength))
    smoothingStrengthRef.current = clamped
    filterRef.current?.configure({ minCutoff: smoothingToMinCutoff(clamped) })
  }, [])

  const setBlinkSensitivity = useCallback((sensitivity: BlinkSensitivity) => {
    blinkSensitivityRef.current = sensitivity
    sourceRef.current?.setBlinkSensitivity(sensitivity)
  }, [])

  /**
   * Hand the tracker's own on-device adaptation one point the user was verifiably
   * looking at. Only the calibration overlay calls this — see the note on
   * `feedAdaptationPoint` for why nothing else may.
   */
  const feedAdaptationPoint = useCallback((x: number, y: number) => {
    return sourceRef.current?.feedAdaptationPoint(x, y) ?? false
  }, [])

  const start = useCallback(async () => {
    if (startedRef.current) return
    const video = videoRef.current
    if (!video) return
    startedRef.current = true
    setError(null)
    setState((prev) => ({
      ...prev,
      status: 'inactive',
      trackingIssue: 'model-loading',
    }))

    const callbacks = {
      onFrame: (frame: GazeFrame) => {
        const now = performance.now()
        const point = frame.point
        rawGazePointRef.current = point
        headRef.current = frame.head

        const model = calibrationModelRef.current
        // The board's layout box, never the magnified grid: re-anchoring a
        // prediction onto a zoomed grid would scale it by the zoom factor.
        const frameRect = getBoardFrameRect(now)
        const modelCorrected = applyCalibrationModel(model, point)
        const boardCorrected = remapForBoard(modelCorrected, model?.boardRect ?? null, frameRect)
        const smoothed =
          filterRef.current?.filter(boardCorrected.x, boardCorrected.y, now) ?? boardCorrected

        /*
         * How far the head has drifted from the pose the model was fitted at.
         * BlazeGaze takes head pose as an input, and our board correction was fit
         * at one pose, so a player who has since leaned in or turned is being
         * mapped by a model that was never shown their current geometry. Nothing
         * here can undo that — you cannot infer the new mapping without new
         * ground truth — but it can stop the tracker from *asserting* squares it
         * has no business asserting, and it lets the UI say "press C" instead of
         * leaving the player to wonder why the board stopped listening.
         */
        const drift = headDriftScore(model?.headPose ?? null, frame.head)
        headDriftRef.current = drift
        const driftPenalty = drift === null ? 1 : Math.max(0.25, 1 - 0.75 * Math.min(1, drift))

        const corrected: GazePoint = {
          ...smoothed,
          // The stabiliser already scores calibration quality as its own term, so
          // only take a light haircut here — multiplying the per-frame confidence
          // by the raw quality score counted it twice and left an honest ~1-square
          // calibration unable to reach the dwell commit threshold.
          confidence:
            point.confidence *
            (model ? Math.max(0.45, model.qualityScore) : 0.3) *
            driftPenalty,
        }
        correctedGazePointRef.current = corrected

        if (now - lastStateCommitAtRef.current >= STATE_COMMIT_MS) {
          lastStateCommitAtRef.current = now
          setState((prev) => ({
            ...prev,
            rawGazePoint: point,
            correctedGazePoint: corrected,
            gazePoint: corrected,
            blinkDetected: frame.eyeClosure > 0.5,
            isCalibrated: !!model,
            headDrift: drift,
            calibrationProgress: model
              ? 100
              : Math.min(99, (calibrationSampleCountRef.current / MIN_CALIBRATION_SAMPLES) * 100),
            calibrationQuality: model?.qualityScore ?? 0,
            calibrationErrorSquares: model?.validationErrorSquares ?? null,
            trackingIssue:
              drift !== null && drift >= 1
                ? 'head-moved'
                : point.confidence < 0.4
                  ? 'low-confidence'
                  : model
                    ? null
                    : 'calibration-incomplete',
          }))
        }
      },
      onBlink: () => {
        setState((prev) => ({ ...prev, blinkDetected: true }))
        blinkSubscribers.current.forEach((cb) => cb())
      },
      onReady: () => {
        setIsReady(true)
        setState((prev) => ({
          ...prev,
          status: 'active',
          cameraPermission: 'granted',
          trackingIssue: calibrationModelRef.current ? null : 'calibration-incomplete',
        }))
      },
      onError: (message: string) => {
        startedRef.current = false
        const denied = /denied/i.test(message)
        setError(message)
        setState((prev) => ({
          ...prev,
          status: 'inactive',
          trackingIssue: denied ? 'camera-denied' : 'camera-unavailable',
          cameraPermission: denied ? 'denied' : prev.cameraPermission,
        }))
      },
    }

    const kind = sourceKindRef.current
    const source: GazeSourceLike =
      kind === 'mediapipe'
        ? new MediaPipeGazeSource(video, callbacks)
        : new WebEyeTrackSource(video, callbacks)

    sourceRef.current = source
    source.setBlinkSensitivity(blinkSensitivityRef.current)
    filterRef.current?.reset()
    await source.start()
    ownsAdaptationRef.current = source.ownsAdaptation
  }, [])

  /**
   * Tear the current estimator down and bring the other one up in its place.
   *
   * The full stop/start is deliberate rather than swapping a callback: both
   * sources own the camera and one of them owns a worker, so sharing a video
   * element between two live pipelines is how you get two streams fighting over
   * the same device. Calibration is stored per source, so switching back later
   * costs nothing.
   */
  const switchSource = useCallback(async (kind: GazeSourceKind, automatic = false) => {
    if (kind === sourceKindRef.current && sourceRef.current) return
    sourceRef.current?.stop()
    sourceRef.current = null
    startedRef.current = false
    ownsAdaptationRef.current = false
    filterRef.current?.reset()
    sourceKindRef.current = kind
    setSourceKindState(kind)
    setAutoSwitched(automatic)
    setIsReady(false)
    setError(null)
    try {
      window.localStorage.setItem(SOURCE_STORAGE_KEY, kind)
    } catch {
      // A refused localStorage only costs the preference, not the switch.
    }
    await startRef.current()
  }, [])

  /** `start` captured in a ref so `switchSource` does not depend on its identity. */
  const startRef = useRef(start)
  startRef.current = start

  /**
   * Automatic fallback. If the chosen estimator never delivers a usable frame,
   * the player gets a dead board and no way to know the other one would have
   * worked — so try the other one for them rather than making a broken tracker
   * the end of the road.
   */
  useEffect(() => {
    if (!startedRef.current || autoSwitched) return
    const id = setTimeout(() => {
      const source = sourceRef.current
      if (!source) return
      if (source.msSinceLastUsableResult() < SOURCE_FALLBACK_MS) return
      void switchSource(
        sourceKindRef.current === 'mediapipe' ? 'webeyetrack' : 'mediapipe',
        true,
      )
    }, SOURCE_FALLBACK_MS)
    return () => clearTimeout(id)
  }, [isReady, autoSwitched, switchSource])

  // Poll the source for throughput, framing and a lost-signal flip. Kept off the
  // per-frame path so it never adds render pressure to the gaze stream itself.
  useEffect(() => {
    if (!isReady) return
    const id = setInterval(() => {
      const source = sourceRef.current
      if (!source) return
      setFps(source.fps)
      if (source.cameraResolution) setCameraResolution(source.cameraResolution)
      const lost = source.msSinceLastUsableResult() > FACE_LOST_MS
      setState((prev) => {
        const status: TrackingStatus = lost ? 'lost' : 'active'
        const trackingIssue = lost
          ? source.trackingIssue ?? 'no-face'
          : source.trackingIssue ?? (calibrationModelRef.current ? null : 'calibration-incomplete')
        return prev.status === status && prev.trackingIssue === trackingIssue
          ? prev
          : { ...prev, status, trackingIssue }
      })
    }, 250)
    return () => clearInterval(id)
  }, [isReady])

  // The tracker lives for the whole page session (WebEyeTrack calibrates in-worker
  // and cannot be cheaply rebuilt); tear it down only when the page unmounts.
  useEffect(() => {
    return () => {
      sourceRef.current?.stop()
      sourceRef.current = null
      startedRef.current = false
    }
  }, [])

  return {
    videoRef,
    state,
    isReady,
    error,
    hasCalibration: calibrationModel !== null,
    calibrationModel,
    calibrationSampleCount,
    rawGazePointRef,
    cameraResolution,
    fps,
    start,
    noteCalibrationSample,
    setCalibrationModel,
    resetCalibration,
    onBlink,
    setSmoothing,
    setBlinkSensitivity,
    feedAdaptationPoint,
    ownsAdaptationRef,
    headPoseRef: headRef,
    headDrift: state.headDrift,
    sourceKind,
    switchSource,
    autoSwitched,
  }
}
