'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ADAPTATION_TARGETS,
  buildCalibrationModel,
  diagnoseCalibrationSamples,
  CALIBRATION_TARGETS,
  createCalibrationSample,
  LOW_QUALITY_ERROR_SQUARES,
  robustPoint,
  targetToViewport,
  VALIDATION_TARGETS_ON_BOARD,
  type CalibrationModel,
  type CalibrationPhase,
  type CalibrationSample,
  type CalibrationTarget,
} from '@/lib/eye-tracking/calibration-model'
import { getBoardGeometry, invalidateBoardGeometry, toBoardRect } from '@/lib/eye-tracking/board-mapping'
import type { GazePoint, HeadPose } from '@/lib/eye-tracking/types'

/**
 * Per-target timing. Trimmed alongside the smaller dot grid: the settle window
 * only has to cover the saccade onto the new dot, and 550ms of sampling at 45ms
 * still yields ~12 frames to take a robust median over. Thirteen targets now run
 * ~12s end to end instead of ~26s.
 */
const SETTLE_MS = 220
const SAMPLE_MS = 550
/**
 * The adaptation phase is paced by WebEyeTrack, not by us: it drops any ground
 * truth point offered within 1s of the previous one, so each dot has to stay up
 * long enough to clear that. The extra time is not wasted — it is all sampling.
 */
const ADAPT_SAMPLE_MS = 950
/** Window over which the live "is the tracker output moving?" spread is measured. */
const SIGNAL_WINDOW_MS = 2500
/**
 * Below this much movement over that window the tracker is effectively pinned.
 * Real gaze wanders tens of pixels even during a deliberate fixation — micro-
 * saccades alone cover more than this — so single-digit spread means the
 * estimator is not responding to the eyes at all.
 */
const PINNED_SPREAD_PX = 6
const SAMPLE_EVERY_MS = 45
const MIN_SAMPLES_PER_TARGET = 6
/** A click still collects for this long, so a target is never fitted to one frame. */
const CLICK_BURST_MS = 220
const CLICK_MIN_SAMPLES = 2

interface CalibrationOverlayProps {
  /** Live raw WebEyeTrack viewport point, read without causing React renders. */
  rawGazePointRef: React.RefObject<GazePoint>
  /** Live head pose, recorded with each sample so the model knows its own pose. */
  headPoseRef?: React.RefObject<HeadPose | null>
  /** Hand one look-aligned point to WebEyeTrack's own on-device adaptation. */
  feedAdaptationPoint?: (x: number, y: number) => boolean
  /** False when the adaptation hook could not be taken over; skips that phase. */
  ownsAdaptationRef?: React.RefObject<boolean>
  /** Calibration model built from the collected board-specific samples. */
  onComplete: (model: CalibrationModel) => void
  /** Progress for the status panel. */
  onProgress?: (completed: number, total: number, phase: CalibrationPhase) => void
  /** Bail out without finishing. */
  onCancel: () => void
}

function resolve(target: CalibrationTarget): { x: number; y: number } {
  const geom = getBoardGeometry()
  if (geom) return targetToViewport(target, toBoardRect(geom))
  const side = Math.min(window.innerWidth, window.innerHeight) * 0.8
  const originX = (window.innerWidth - side) / 2
  const originY = (window.innerHeight - side) / 2
  return { x: originX + target.fx * side, y: originY + target.fy * side }
}

function rectForCurrentBoard() {
  const geom = getBoardGeometry()
  return geom ? toBoardRect(geom) : null
}

export default function CalibrationOverlay({
  rawGazePointRef,
  headPoseRef,
  feedAdaptationPoint,
  ownsAdaptationRef,
  onComplete,
  onProgress,
  onCancel,
}: CalibrationOverlayProps) {
  /** Whether the tracker's own adaptation can be taught; decided once, on mount. */
  const canAdaptRef = useRef<boolean>(!!feedAdaptationPoint && ownsAdaptationRef?.current !== false)
  const fitSamplesRef = useRef<CalibrationSample[]>([])
  /** Adaptation dots successfully handed to the tracker. */
  const adaptedCountRef = useRef(0)
  const validationSamplesRef = useRef<CalibrationSample[]>([])
  /**
   * The parent re-renders ~20x/second while the tracker streams gaze results, so
   * its inline handlers get a fresh identity every frame. Holding them in refs
   * keeps them out of the sampling effect's dependencies — otherwise that effect
   * tore itself down and restarted before its 350ms settle timer could ever fire,
   * and the target dot pulsed forever without collecting anything.
   */
  const onProgressRef = useRef(onProgress)
  const onCompleteRef = useRef(onComplete)
  const onCancelRef = useRef(onCancel)
  const [phase, setPhase] = useState<CalibrationPhase>(
    !!feedAdaptationPoint && ownsAdaptationRef?.current !== false ? 'adapting' : 'collecting',
  )
  const [index, setIndex] = useState(0)
  const [retryKey, setRetryKey] = useState(0)
  const [sampling, setSampling] = useState(false)
  const [message, setMessage] = useState('Look at the target')
  const [layoutTick, setLayoutTick] = useState(0)
  /** True once at least one usable gaze point has been read from the tracker. */
  const [hasSignal, setHasSignal] = useState(false)
  /** Mean px the raw estimate has wandered recently; null until enough samples. */
  const [signalSpread, setSignalSpread] = useState<number | null>(null)
  /** The rejected model, kept so "use it anyway" does not require a redo. */
  const [rejectedModel, setRejectedModel] = useState<CalibrationModel | null>(null)
  /** Set while a target is live: captures it immediately (click / Space). */
  const finishRef = useRef<(() => void) | null>(null)
  /** Current phase, readable from the window-level handlers below. */
  const phaseRef = useRef<CalibrationPhase>('collecting')

  const targets =
    phase === 'adapting'
      ? ADAPTATION_TARGETS
      : phase === 'validating'
        ? VALIDATION_TARGETS_ON_BOARD
        : CALIBRATION_TARGETS
  const adaptTotal = canAdaptRef.current ? ADAPTATION_TARGETS.length : 0
  const total = adaptTotal + CALIBRATION_TARGETS.length + VALIDATION_TARGETS_ON_BOARD.length
  const completed =
    adaptedCountRef.current +
    fitSamplesRef.current.length +
    validationSamplesRef.current.length +
    (sampling ? 0.5 : 0)
  const displayTarget = targets[index]
  const dot = useMemo(
    () => (displayTarget ? resolve(displayTarget) : null),
    [displayTarget, index, layoutTick, phase],
  )

  phaseRef.current = phase
  onProgressRef.current = onProgress
  onCompleteRef.current = onComplete
  onCancelRef.current = onCancel

  useEffect(() => {
    onProgressRef.current?.(Math.floor(completed), total, phase)
  }, [completed, phase, total])

  useEffect(() => {
    /*
     * Rolling window of recent raw points, so the header can say whether the
     * tracker's output is actually *moving*.
     *
     * "Is a point arriving" and "is that point responding to my eyes" are
     * different questions, and only the first one was ever asked. A stream
     * pinned to one spot answers the first question yes, sails through
     * calibration, and comes out the far side as a confident-looking model with
     * a stable ~3.4-square error — the number you get when the regression can
     * only learn "predict the middle of the board". Showing the spread live
     * turns fifteen wasted seconds into an immediate answer.
     */
    const recent: Array<{ x: number; y: number; t: number }> = []
    const id = setInterval(() => {
      invalidateBoardGeometry()
      setLayoutTick((tick) => tick + 1)
      const point = rawGazePointRef.current
      const live = point.confidence >= 0.35 && Number.isFinite(point.x)
      setHasSignal(live)

      const now = performance.now()
      if (live) recent.push({ x: point.x, y: point.y, t: now })
      while (recent.length && now - recent[0].t > SIGNAL_WINDOW_MS) recent.shift()
      if (recent.length >= 5) {
        const cx = recent.reduce((sum, p) => sum + p.x, 0) / recent.length
        const cy = recent.reduce((sum, p) => sum + p.y, 0) / recent.length
        setSignalSpread(
          recent.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / recent.length,
        )
      } else {
        setSignalSpread(null)
      }
    }, 200)
    return () => clearInterval(id)
  }, [rawGazePointRef])

  const restart = useCallback(() => {
    fitSamplesRef.current = []
    validationSamplesRef.current = []
    // Adaptation is not repeated: it has already moved the tracker's own model,
    // and re-teaching the same five points would only re-confirm what it learned
    // while costing the user another six seconds. A retry refits our layer.
    adaptedCountRef.current = adaptTotal
    setRejectedModel(null)
    setSampling(false)
    setIndex(0)
    setPhase('collecting')
    setMessage('Look at the target')
  }, [adaptTotal])

  const acceptRejected = useCallback(() => {
    if (rejectedModel) onCompleteRef.current(rejectedModel)
  }, [rejectedModel])

  /** Latest action handlers for the window-level click interceptor below. */
  const actionsRef = useRef({ restart, acceptRejected })
  actionsRef.current = { restart, acceptRejected }

  /**
   * Swallow every click while calibrating, at the capture phase, before it can
   * reach the window.
   *
   * WebEyeTrack's proxy installs its own bubble-phase window click listener and
   * adapts the on-device model on each click, treating the *cursor* as ground
   * truth for where the user is looking. During calibration the cursor sits
   * wherever the mouse was left while the eyes are on the dot, so those clicks
   * teach the tracker a mapping toward the mouse and shift the raw stream from
   * one target to the next — the fit is then chasing a moving source and the
   * validation error stays stuck above the reject line however carefully the
   * user holds their gaze. Capturing here (and driving our own buttons from the
   * same handler, since nothing downstream sees the event) keeps the raw stream
   * stationary for the length of the calibration.
   */
  useEffect(() => {
    const onWindowClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      const el = e.target instanceof Element ? e.target.closest('[data-calibration-action]') : null
      switch (el?.getAttribute('data-calibration-action')) {
        case 'cancel':
          onCancelRef.current()
          break
        case 'restart':
          actionsRef.current.restart()
          break
        case 'accept':
          actionsRef.current.acceptRejected()
          break
        default:
          // In the adaptation phase the dot is paced by the library's own
          // debounce, so a click cannot usefully shorten it.
          if (phaseRef.current !== 'adapting') finishRef.current?.()
      }
    }
    window.addEventListener('click', onWindowClick, true)
    return () => window.removeEventListener('click', onWindowClick, true)
  }, [])

  const storeTarget = useCallback(
    (target: CalibrationTarget, raw: { x: number; y: number }) => {
      const boardRect = rectForCurrentBoard()
      if (!boardRect) {
        setMessage('Board is not measurable yet')
        return false
      }

      const sample = createCalibrationSample(target, raw, boardRect, headPoseRef?.current ?? null)
      if (phase === 'validating') validationSamplesRef.current.push(sample)
      else fitSamplesRef.current.push(sample)
      return true
    },
    [phase, headPoseRef],
  )

  useEffect(() => {
    if (!displayTarget || phase === 'complete' || phase === 'low-quality') return

    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let finishTimer: ReturnType<typeof setTimeout> | null = null
    const points: Array<{ x: number; y: number }> = []

    setSampling(false)
    setMessage(
      phase === 'adapting'
        ? 'Teaching the tracker your eyes'
        : phase === 'validating'
          ? 'Checking the result'
          : 'Look at the target',
    )

    const retry = (delay: number) => {
      setTimeout(() => {
        if (!cancelled) setRetryKey((value) => value + 1)
      }, delay)
    }

    const collect = () => {
      const point = rawGazePointRef.current
      if (point.confidence >= 0.35 && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        points.push({ x: point.x, y: point.y })
        setHasSignal(true)
      }
    }

    /**
     * Commit this target. `minSamples` is relaxed for a click-confirmed capture:
     * the user is telling us they are on the dot right now, so a short burst is
     * enough — waiting out the full hold would just discard their input.
     */
    const commit = (minSamples: number) => {
      if (cancelled) return
      if (interval) clearInterval(interval)
      if (settleTimer) clearTimeout(settleTimer)
      if (finishTimer) clearTimeout(finishTimer)
      finishRef.current = null
      setSampling(false)

      const raw = points.length >= minSamples ? robustPoint(points) : null
      if (!raw) {
        setMessage(
          points.length === 0
            ? 'No gaze signal yet — make sure your face is lit and in frame.'
            : 'Tracking was unstable. Trying this target again.',
        )
        retry(450)
        return
      }

      if (phase === 'adapting') {
        /*
         * Hand this dot to WebEyeTrack's own adaptation rather than to our
         * regression. The library refuses points offered too soon after the last
         * one, so a refusal is a pacing problem, not a bad sample: wait out its
         * debounce and offer the same dot again rather than moving on and
         * quietly teaching it four points instead of five.
         */
        const dotPoint = resolve(displayTarget)
        const accepted = feedAdaptationPoint?.(dotPoint.x, dotPoint.y) ?? false
        if (!accepted) {
          setMessage('Hold it there a moment longer…')
          retry(400)
          return
        }
        adaptedCountRef.current += 1

        const nextAdapt = index + 1
        if (nextAdapt < targets.length) {
          setIndex(nextAdapt)
          return
        }
        // The adaptation has just changed the mapping the raw stream comes out
        // of, so everything sampled from here is measured against the new base.
        setPhase('collecting')
        setIndex(0)
        return
      }

      const stored = storeTarget(displayTarget, raw)
      // Board unmeasurable (mid-layout): retry instead of stalling here forever.
      if (!stored) {
        retry(450)
        return
      }

      const next = index + 1
      if (next < targets.length) {
        setIndex(next)
        return
      }

      if (phase === 'collecting') {
        setPhase('validating')
        setIndex(0)
        return
      }

      const boardRect = rectForCurrentBoard()

      /*
       * Check the input before trusting the fit. A pinned gaze stream produces a
       * confident-looking model with a stable ~3.4-square error, which sends the
       * player off to fix their lighting when the tracker was never producing an
       * estimate at all. Say what actually happened instead.
       */
      const diagnostics = diagnoseCalibrationSamples(fitSamplesRef.current)
      if (diagnostics.degenerate) {
        setRejectedModel(null)
        setPhase('low-quality')
        setMessage(
          'The eye tracker is not producing a usable signal — your gaze barely moved ' +
            'between dots, so there is nothing to calibrate against. This is a tracking ' +
            'problem, not an accuracy one: check that your whole face is lit and in frame, ' +
            'take off reflective glasses if you can, and try again.',
        )
        return
      }

      const model =
        boardRect &&
        buildCalibrationModel(
          fitSamplesRef.current,
          validationSamplesRef.current,
          boardRect,
        )

      if (!model) {
        setRejectedModel(null)
        setPhase('low-quality')
        setMessage('Calibration failed — no usable fit from these samples.')
        return
      }

      // One source of truth for "too inaccurate to use": the model's own reject
      // line. The overlay used to apply a second, stricter cut of its own.
      if (model.validationErrorSquares > LOW_QUALITY_ERROR_SQUARES) {
        setRejectedModel(model)
        setPhase('low-quality')
        setMessage(
          `Accuracy came out at about ${model.validationErrorSquares.toFixed(1)} squares — ` +
            'more than a square off. Better light on your face, a steadier head and holding ' +
            'each dot a beat longer usually fixes it. ' +
            `(Tracker signal ${(diagnostics.signalRatio * 100).toFixed(0)}% of target spread.)`,
        )
        return
      }

      setPhase('complete')
      setMessage(
        model.validationErrorSquares > LOW_QUALITY_ERROR_SQUARES * 0.7
          ? 'Calibration saved with low accuracy'
          : 'Calibration complete',
      )
      onCompleteRef.current(model)
    }

    settleTimer = setTimeout(() => {
      if (cancelled) return
      setSampling(true)
      setMessage(
        phase === 'adapting'
          ? 'Hold your gaze on the dot'
          : 'Hold your gaze (or click / press Space)',
      )
      interval = setInterval(collect, SAMPLE_EVERY_MS)
      finishTimer = setTimeout(
        () => commit(MIN_SAMPLES_PER_TARGET),
        phase === 'adapting' ? ADAPT_SAMPLE_MS : SAMPLE_MS,
      )
    }, SETTLE_MS)

    /**
     * Manual capture: a click (or Space) grabs the point being looked at now.
     * It still runs a short burst rather than committing the single frame under
     * the cursor — one sample of a noisy stream per target is what produced
     * unusable fits, and 220ms costs the user nothing.
     */
    finishRef.current = () => {
      if (cancelled) return
      finishRef.current = null
      if (settleTimer) clearTimeout(settleTimer)
      if (finishTimer) clearTimeout(finishTimer)
      if (!interval) {
        setSampling(true)
        interval = setInterval(collect, SAMPLE_EVERY_MS)
      }
      collect()
      finishTimer = setTimeout(() => commit(CLICK_MIN_SAMPLES), CLICK_BURST_MS)
    }

    return () => {
      cancelled = true
      finishRef.current = null
      if (settleTimer) clearTimeout(settleTimer)
      if (finishTimer) clearTimeout(finishTimer)
      if (interval) clearInterval(interval)
    }
  }, [
    displayTarget,
    feedAdaptationPoint,
    index,
    phase,
    rawGazePointRef,
    retryKey,
    storeTarget,
    targets.length,
  ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current()
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (phase === 'low-quality') restart()
        else if (phase !== 'adapting') finishRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, restart])

  const progress = total ? (completed / total) * 100 : 0
  const phaseLabel =
    phase === 'adapting' ? 'Learning your eyes' : phase === 'validating' ? 'Checking' : 'Calibration'
  const currentNumber =
    phase === 'adapting'
      ? index + 1
      : phase === 'validating'
        ? adaptTotal + CALIBRATION_TARGETS.length + index + 1
        : adaptTotal + index + 1

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-[#05070a]/90 backdrop-blur-sm" />

      {/* Bright, large type throughout: this is read at arm's length, often by
          someone who cannot comfortably read 12px grey-on-grey. */}
      <div className="absolute top-6 left-1/2 z-10 w-[min(94vw,34rem)] -translate-x-1/2 text-center space-y-3 px-4 pointer-events-none">
        <h2 className="text-3xl font-extrabold tracking-tight text-white">{phaseLabel}</h2>
        <p className="text-xl font-semibold text-[#ffd24a]">{message}</p>
        {phase !== 'low-quality' && (
          <>
            <p className="text-lg font-bold text-white">
              Dot {Math.min(currentNumber, total)} of {total}
            </p>
            <p className="text-base text-[#e8eef7]">
              Head still — move only your eyes.
            </p>
            <p className={`text-base ${hasSignal ? 'text-[#7fd4ff]' : 'text-[#ff9d42] font-bold'}`}>
              {hasSignal
                ? 'Tracking live — look at the dot and hold'
                : 'Waiting for the eye tracker… (camera on? face in frame?)'}
            </p>
            {hasSignal && signalSpread !== null && (
              <p
                className={`text-base font-bold ${
                  signalSpread < PINNED_SPREAD_PX ? 'text-[#ff5c5c]' : 'text-[#7fd4ff]/80'
                }`}
              >
                {signalSpread < PINNED_SPREAD_PX
                  ? `Tracker output is not moving (${signalSpread.toFixed(0)}px) — it is not seeing your eyes`
                  : `Tracker signal ${signalSpread.toFixed(0)}px`}
              </p>
            )}
            <div className="mx-auto h-2 w-full rounded-full bg-white/20 overflow-hidden">
              <motion.div
                className="h-full bg-[#ffd24a]"
                initial={false}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.2 }}
              />
            </div>
          </>
        )}
      </div>

      <AnimatePresence mode="wait">
        {dot && phase !== 'complete' && phase !== 'low-quality' && (
          <motion.div
            key={`${phase}-${index}`}
            aria-hidden
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{ left: dot.x, top: dot.y }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
          >
            <span className="relative flex items-center justify-center">
              <motion.span
                animate={{ scale: sampling ? [1, 1.35] : [1, 1.7], opacity: [0.9, 0] }}
                transition={{ duration: sampling ? 0.45 : 1.1, repeat: Infinity }}
                className="absolute w-20 h-20 rounded-full border-4 border-[#ffd24a]"
              />
              <span className="block w-9 h-9 rounded-full bg-[#ffd24a] shadow-[0_0_28px_rgba(255,210,74,0.8)]" />
              <span className="absolute block w-2.5 h-2.5 rounded-full bg-[#0d1117]" />
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A rejected calibration is a fork in the road, not a dead end: redo it,
          or play with what we have (the board still stabilises and dwells). */}
      {phase === 'low-quality' && (
        <div className="absolute top-1/2 left-1/2 z-10 flex w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
          <button
            type="button"
            data-calibration-action="restart"
            className="w-full rounded-xl bg-[#ffd24a] px-6 py-4 text-lg font-extrabold text-[#0d1117]"
          >
            Try again
          </button>
          {rejectedModel && (
            <button
              type="button"
              data-calibration-action="accept"
              className="w-full rounded-xl border-2 border-[#7fd4ff] px-6 py-4 text-lg font-bold text-[#7fd4ff]"
            >
              Use it anyway
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        data-calibration-action="cancel"
        className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 rounded-lg border-2 border-white/60 bg-[#0d1117] px-5 py-3 text-base font-semibold text-white hover:bg-white/10"
      >
        Cancel calibration (Esc)
      </button>
    </div>
  )
}
