'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, FlipVertical2, AlertCircle } from 'lucide-react'
import Chessboard from '@/components/game/Chessboard'
import LeftSidebar from '@/components/layout/LeftSidebar'
import EyeTrackingPanel from '@/components/eye-tracking/EyeTrackingPanel'
import GazeCursor from '@/components/eye-tracking/GazeCursor'
import GazeDebugOverlay from '@/components/eye-tracking/GazeDebugOverlay'
import CalibrationOverlay from '@/components/eye-tracking/CalibrationOverlay'
import GazeGuideOverlay, {
  type GazeGuideReason,
  type GazeGuideVariant,
} from '@/components/eye-tracking/GazeGuideOverlay'
import MoveHistoryPanel from '@/components/move-history/MoveHistoryPanel'
import GameOverModal from '@/components/game/GameOverModal'
import TopNav from '@/components/layout/TopNav'
import AccessibilityMenu from '@/components/accessibility/AccessibilityMenu'
import { createInitialGameState } from '@/lib/chess/mock-data'
import { DEFAULT_ACCESSIBILITY_SETTINGS } from '@/lib/eye-tracking/mock-data'
import { GameState, BoardPosition, isGameOver } from '@/lib/chess/types'
import { describeOutcome } from '@/lib/chess/outcome'
import { AccessibilitySettings } from '@/lib/eye-tracking/types'
import { makeMove, getPieceAt } from '@/lib/chess/engine'
import { getBestMove } from '@/lib/chess/stockfish-api'
import { applyUciMove } from '@/lib/chess/apply-move'
import { useGazeTracking } from '@/lib/eye-tracking/useGazeTracking'
import { useGazeInteraction } from '@/lib/eye-tracking/useGazeInteraction'
import { useGazeRegionDwell } from '@/lib/eye-tracking/useGazeRegionDwell'
import { toAlgebraic, getBoardGeometry, invalidateBoardGeometry } from '@/lib/eye-tracking/board-mapping'
import { DEFAULT_ORIENTATION, toLogical, type BoardOrientation } from '@/lib/chess/orientation'
import { GAZE_SOURCE_LABELS } from '@/lib/eye-tracking/types'

/**
 * Smallest square (CSS px) at which gaze selection is allowed. Gaze error is
 * roughly fixed in pixels, so below this the cursor deadband and landmark noise
 * start to span more than a square. Fullscreen on any normal display clears it
 * comfortably (~90-130px), which is exactly why gaze is gated to fullscreen.
 */
const MIN_GAZE_SQUARE_PX = 80

/**
 * Seconds of gaze control on the player's own turn without a completed move
 * before the how-to-play card comes back. Counted only while gaze is actually
 * driving the board, so a game left open in another tab never trips it. Long
 * enough (45s) that thinking about a position is not mistaken for being stuck.
 */
const STRUGGLE_SECONDS = 45

/** Blink-confirms that produced no legal move before we re-show the guide. */
const STRUGGLE_FAILED_ATTEMPTS = 3

/**
 * Coarse-to-fine selection: at every step the player picks one quarter of what
 * is currently on screen, and that quarter is magnified to fill the frame.
 * Repeating that from the whole board reaches a single square in three looks
 * (8x8 -> 4x4 -> 2x2 -> 1).
 *
 * This is the setting that decides whether the game is playable at all on a
 * given tracker, and the reason it halves rather than jumping straight to
 * squares is worth stating precisely.
 *
 * Gaze error is roughly constant in *pixels*. Picking a square directly off the
 * full board means hitting a target one square wide, so the estimate has to be
 * good to about half a square — around 50px on a typical fullscreen board. No
 * consumer webcam pipeline does that reliably, and no amount of dwell time or
 * smoothing fixes an error larger than the target.
 *
 * Halving keeps the target the same size on screen at every step: the quarter
 * being chosen is always half the visible frame, so the tolerance is always a
 * quarter of the frame — about 200px, or four times what direct selection
 * demands, and the *same* at each step so there is no weak link. A first attempt
 * at this used one coarse pick then a direct square pick, which looked
 * equivalent but was not: the final step still had to resolve a square inside a
 * quarter-sized frame, at 100px, and that step alone set the accuracy the whole
 * scheme needed. `npm run verify:gaze` checks the tolerance is uniform.
 */
const COARSE_DIVISIONS = 2
/** Board edge in squares; the zoom stack halves from here down to one. */
const FULL_REGION = 8

/** How long the gaze must sit off the board to back out of a magnified block. */
const ZOOM_CANCEL_MS = 1400

/** Where the accessibility settings are remembered between visits. */
const ACCESSIBILITY_STORAGE_KEY = 'armaan.chess.accessibility.v1'

export default function GamePage() {
  const [gameState, setGameState] = useState<GameState>(createInitialGameState())
  const [timer, setTimer] = useState(600)
  const [difficulty, setDifficulty] = useState('Intermediate')
  const [engineThinking, setEngineThinking] = useState(false)
  const [accessibility, setAccessibility] = useState<AccessibilitySettings>(
    DEFAULT_ACCESSIBILITY_SETTINGS
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * Whether the player has waved the result away to look at the final position.
   * Reset whenever the game returns to a live status, so the next game's result
   * announces itself instead of inheriting the last one's dismissal.
   */
  const [resultDismissed, setResultDismissed] = useState(false)
  // Collapsible side panels (lg and up); the board expands into the freed space.
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  /**
   * Eye control runs only in true fullscreen: it strips all chrome so the board
   * fills the screen (guaranteeing squares well above {@link MIN_GAZE_SQUARE_PX}),
   * and it is the deliberate "I'm playing with my eyes now" gesture. `focusMode`
   * tracks the fullscreen state so the existing chrome-hiding layout follows it.
   */
  const [isFullscreen, setIsFullscreen] = useState(false)
  const focusMode = isFullscreen
  const [showCalibration, setShowCalibration] = useState(false)
  /**
   * Which instruction card is up, if any. Two of the client's notes are served
   * here: setup instructions *before* the dots appear, and a how-to-play card
   * *after* calibration succeeds (and again whenever the player gets stuck).
   */
  const [guide, setGuide] = useState<GazeGuideVariant | null>(null)
  const [guideReason, setGuideReason] = useState<GazeGuideReason>('first-time')
  /**
   * Transient "that blink did nothing, and here is why" banner. Without it a
   * failed confirm is silent, which is what "the game does not move as well as
   * it should" feels like from the player's side of the screen.
   */
  const [hint, setHint] = useState<string | null>(null)
  /**
   * Coarse-to-fine is on by default for gaze. It costs one extra look per move
   * and is the difference between "the board follows my eyes" and "the board
   * cannot tell which square I mean" on any consumer webcam. Toggle with Z for
   * anyone whose tracking is good enough to go straight to squares.
   */
  const [coarseToFine, setCoarseToFine] = useState(true)
  /** The magnified block, in drawn cell coordinates, or null at the coarse stage. */
  const [zoomRegion, setZoomRegion] = useState<{
    row: number
    col: number
    size: number
  } | null>(null)
  const [debugGaze, setDebugGaze] = useState(false)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  /** Board square edge in px, polled while in gaze mode for the size gate. */
  const [squareSize, setSquareSize] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /**
   * Which side is drawn at the top. Defaults to white — the player's own pieces
   * — because that is the half of the board they look at most to pick a piece,
   * and the upper half of the screen is where gaze tracking is most reliable.
   */
  const [orientation, setOrientation] = useState<BoardOrientation>(DEFAULT_ORIENTATION)

  // Human plays White; the backend Stockfish plays Black.
  const isHumanTurn =
    gameState.whiteToMove && !engineThinking && !isGameOver(gameState.status)

  // The human is White, so the outcome is read from the human's point of view.
  const outcome = describeOutcome(gameState.status, gameState.whiteToMove, 'white')

  // Real eye tracking — WebEyeTrack (webcam + BlazeGaze CNN in a worker).
  const gaze = useGazeTracking()

  const eyeTrackingState = {
    ...gaze.state,
    calibrationProgress: showCalibration
      ? calibrationProgress
      : gaze.hasCalibration
        ? 100
        : gaze.state.calibrationProgress,
    status: showCalibration ? 'calibrating' as const : gaze.state.status,
  }

  // --- Fullscreen eye-control lifecycle ---------------------------------------

  /**
   * Seconds spent in gaze control, on the player's turn, since anything actually
   * happened. Reset by a completed move and by dismissing an instruction card.
   */
  const idleSecondsRef = useRef(0)
  /** Blink-confirms since the last completed move that produced no legal move. */
  const failedAttemptsRef = useRef(0)

  const noteProgress = useCallback(() => {
    idleSecondsRef.current = 0
    failedAttemptsRef.current = 0
  }, [])

  /** Re-show the how-to-play card because the player is evidently stuck. */
  const showStruggleGuide = useCallback(() => {
    noteProgress()
    setGuideReason('struggling')
    setGuide('how-to-play')
  }, [noteProgress])

  const enterEyeControl = useCallback(() => {
    const el = rootRef.current
    // requestFullscreen must run inside the user gesture, before any await.
    if (el && !document.fullscreenElement) {
      el.requestFullscreen().catch(() => {})
    }
    gaze.start()
    noteProgress()
    // Instructions first, dots second — the setup advice (lighting, distance,
    // still head) is only useful before the tracker starts sampling.
    if (!gaze.hasCalibration) {
      setGuideReason('first-time')
      setGuide('before-calibration')
    }
  }, [gaze, noteProgress])

  const restartCalibration = useCallback(() => {
    gaze.resetCalibration()
    setCalibrationProgress(0)
    setShowCalibration(false)
    const el = rootRef.current
    if (el && !document.fullscreenElement) {
      el.requestFullscreen().catch(() => {})
    }
    gaze.start()
    noteProgress()
    setGuideReason('manual')
    setGuide('before-calibration')
  }, [gaze, noteProgress])

  const exitEyeControl = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }, [])

  // Keep our flags in step with the browser's fullscreen state (Esc, F11, etc.).
  useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement && document.fullscreenElement === rootRef.current
      setIsFullscreen(fs)
      if (!fs) {
        setShowCalibration(false)
        setGuide(null)
        setZoomRegion(null)
      }
      invalidateBoardGeometry()
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // Poll the board's square size while in gaze mode, for the size gate + nudge.
  useEffect(() => {
    if (!isFullscreen) {
      setSquareSize(0)
      return
    }
    const id = setInterval(() => {
      const g = getBoardGeometry()
      setSquareSize(g?.squareSize ?? 0)
    }, 300)
    return () => clearInterval(id)
  }, [isFullscreen])

  // F toggles fullscreen eye control, C recalibrates, H re-shows the
  // instructions, Z toggles coarse-to-fine, T swaps the tracker, V flips the
  // board. Reaching
  // a button is exactly the interaction a gaze user finds hardest, so the view
  // controls stay keyboard-first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        if (document.fullscreenElement) exitEyeControl()
        else enterEyeControl()
      } else if (e.key === 'c' || e.key === 'C') {
        if (isFullscreen) {
          restartCalibration()
        }
      } else if (e.key === 'h' || e.key === 'H' || e.key === '?') {
        // Instructions on demand — the same card the watchdog raises.
        e.preventDefault()
        if (isFullscreen) {
          setGuideReason('manual')
          setGuide('how-to-play')
        }
      } else if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        setCoarseToFine((on) => !on)
        setZoomRegion(null)
      } else if (e.key === 't' || e.key === 'T') {
        // Swap estimators without leaving the game. Each keeps its own
        // calibration, so switching back is free.
        e.preventDefault()
        void gaze.switchSource(gaze.sourceKind === 'mediapipe' ? 'webeyetrack' : 'mediapipe')
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        setDebugGaze((enabled) => !enabled)
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault()
        setOrientation((o) => (o === 'white-top' ? 'white-bottom' : 'white-top'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enterEyeControl, exitEyeControl, gaze, isFullscreen, restartCalibration])

  // The hint is a nudge, not a dialog: it clears itself.
  useEffect(() => {
    if (!hint) return
    const id = setTimeout(() => setHint(null), 5000)
    return () => clearTimeout(id)
  }, [hint])

  // A live game can never be sitting on a dismissed result.
  useEffect(() => {
    if (!isGameOver(gameState.status)) setResultDismissed(false)
  }, [gameState.status])

  // Simulate timer countdown
  useEffect(() => {
    const interval = setInterval(() => {
      setTimer((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  /**
   * Accessibility settings persist and drive the palette. `highContrast` was a
   * dead toggle until now — it flips a class on <html>, which swaps every colour
   * token (chrome *and* board) for the high-contrast set in globals.css.
   */
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ACCESSIBILITY_STORAGE_KEY)
      if (stored) {
        setAccessibility((prev) => ({ ...prev, ...(JSON.parse(stored) as AccessibilitySettings) }))
      }
    } catch {
      // Corrupt or unavailable storage just means the defaults stand.
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('high-contrast', accessibility.highContrast)
    try {
      window.localStorage.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(accessibility))
    } catch {
      // Non-fatal: the setting still applies for this session.
    }
  }, [accessibility])

  // Push the smoothing setting into the tracker whenever it changes.
  useEffect(() => {
    if (gaze.isReady) gaze.setSmoothing(accessibility.smoothing / 100)
  }, [gaze.isReady, accessibility.smoothing, gaze.setSmoothing])

  // Blink sensitivity was a settings control wired to nothing; it now sets how
  // long and how firmly the eyes must close before a blink counts as a confirm.
  useEffect(() => {
    gaze.setBlinkSensitivity(accessibility.blinkSensitivity)
  }, [accessibility.blinkSensitivity, gaze.setBlinkSensitivity])

  // When it becomes Black's turn, ask the backend Stockfish for its move.
  const requestedForMoveCount = useRef(-1)
  useEffect(() => {
    if (gameState.whiteToMove) return
    if (isGameOver(gameState.status)) return
    if (requestedForMoveCount.current === gameState.moves.length) return
    requestedForMoveCount.current = gameState.moves.length

    let cancelled = false
    setEngineThinking(true)

    getBestMove(gameState, difficulty)
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setEngineThinking(false)
          return
        }
        setGameState((prev) => {
          if (!result.move) return prev
          return applyUciMove(prev, result.move) ?? prev
        })
        setEngineThinking(false)
      })
      .catch(() => {
        if (!cancelled) setEngineThinking(false)
      })

    return () => {
      cancelled = true
    }
  }, [gameState, difficulty])

  /** Latest board state, read by handlers that must branch on it before setting. */
  const gameStateRef = useRef(gameState)
  gameStateRef.current = gameState

  // Gaze dwell selects a piece; a deliberate blink confirms the move.
  /**
   * Act on a square the player has picked by eye: select their own piece, or —
   * if one is already selected — play the move. Shared by the zoom stack and by
   * the direct dwell path so both behave identically.
   */
  const commitGazeSquare = useCallback(
    (pos: BoardPosition) => {
      const current = gameStateRef.current
      if (!current.whiteToMove || isGameOver(current.status)) return

      const piece = getPieceAt(current.board, pos.row, pos.col)
      const myColor = current.whiteToMove ? 'white' : 'black'

      if (piece && piece.color === myColor) {
        setHint(null)
        setGameState({ ...current, selectedSquare: pos })
        return
      }

      if (!current.selectedSquare) {
        setHint('Pick one of your own pieces first — that square is not yours to move.')
        return
      }

      const next = makeMove(current, current.selectedSquare, pos)
      if (!next) {
        failedAttemptsRef.current += 1
        setHint('That is not a legal move for the selected piece. Its legal squares are highlighted.')
        if (failedAttemptsRef.current >= STRUGGLE_FAILED_ATTEMPTS) showStruggleGuide()
        return
      }

      setHint(null)
      setGameState(next)
      noteProgress()
    },
    [noteProgress, showStruggleGuide],
  )

  const handleGazeDwell = (pos: BoardPosition) => {
    if (!isHumanTurn) return
    // Back out to the whole board after every fine-stage commit: the next thing
    // the player needs is a different quadrant (the destination), and leaving
    // them zoomed into the piece they just picked would make the far side of the
    // board unreachable without an explicit "zoom out" they have no way to ask
    // for by eye.
    setZoomRegion(null)
    setGameState((prev) => {
      const piece = getPieceAt(prev.board, pos.row, pos.col)
      const myColor = prev.whiteToMove ? 'white' : 'black'

      if (prev.selectedSquare?.row === pos.row && prev.selectedSquare?.col === pos.col) {
        return { ...prev, selectedSquare: null }
      }
      if (piece && piece.color === myColor) {
        return { ...prev, selectedSquare: pos }
      }
      return prev
    })
  }

  /**
   * Blink confirm. The legality check runs outside the state updater so a blink
   * that lands on nothing (no piece selected, or an illegal destination) can be
   * counted: three of those in a row is the "user is failing to move a piece"
   * signal that brings the instructions back.
   */
  const handleBlinkConfirm = (pos: BoardPosition | null) => {
    if (!pos || !isHumanTurn) return
    const current = gameStateRef.current
    const next = current.selectedSquare
      ? makeMove(current, current.selectedSquare, pos)
      : null

    if (!next) {
      failedAttemptsRef.current += 1
      setHint(
        current.selectedSquare
          ? 'That square is not a legal move for the selected piece — look at a highlighted square, then blink.'
          : 'No piece selected yet — hold your gaze on one of your own pieces until the ring fills, then blink.',
      )
      if (failedAttemptsRef.current >= STRUGGLE_FAILED_ATTEMPTS) showStruggleGuide()
      return
    }

    setHint(null)
    setZoomRegion(null)
    setGameState(next)
    noteProgress()
  }

  // Gaze control requires: the tracker up, enough calibration collected, real
  // fullscreen, a board large enough for square-accurate gaze, and no calibration
  // overlay in progress. Any of these missing leaves the game mouse-only.
  const boardBigEnough = squareSize >= MIN_GAZE_SQUARE_PX
  const gazeControlReady =
    gaze.isReady &&
    gaze.hasCalibration &&
    isFullscreen &&
    boardBigEnough &&
    !showCalibration &&
    !guide

  /**
   * Sticky "the head has moved" flag. The drift score is noisy frame to frame,
   * so it latches on at 1 and only clears once the player is well back inside
   * the pose the model was fitted at — a banner that blinks on and off is worse
   * than no banner.
   */
  const [headMoved, setHeadMoved] = useState(false)
  useEffect(() => {
    const drift = gaze.headDrift
    if (drift === null) return
    setHeadMoved((was) => (was ? drift > 0.6 : drift >= 1))
  }, [gaze.headDrift])

  // "Spends too long attempting to move" watchdog. Time is accumulated only
  // while gaze is genuinely driving the board on the player's own turn, so
  // thinking time during the engine's reply, or a tab left open, never counts.
  useEffect(() => {
    if (!gazeControlReady || !isHumanTurn) return
    const id = setInterval(() => {
      idleSecondsRef.current += 1
      if (idleSecondsRef.current >= STRUGGLE_SECONDS) showStruggleGuide()
    }, 1000)
    return () => clearInterval(id)
  }, [gazeControlReady, isHumanTurn, showStruggleGuide])

  /*
   * Two selection stages share one gaze stream, and exactly one of them is live
   * at a time. At the coarse stage the region dwell owns the gaze and the square
   * dwell is disabled, so a stray square commit cannot fire behind the zoom; once
   * a region is chosen they swap. With coarse-to-fine off, the square dwell runs
   * the whole time exactly as before.
   */
  const coarseStageActive = coarseToFine && gazeControlReady && isHumanTurn
  const fineStageActive = gazeControlReady && isHumanTurn && !coarseToFine

  /**
   * One dwell step of the zoom stack. The board frame always displays the
   * current region, so dwelling on a quarter *of the frame* is dwelling on a
   * quarter of that region — the hook needs to know nothing about the stack.
   */
  const {
    region: pendingRegion,
    progress: regionProgress,
    onBoard: regionOnBoard,
  } = useGazeRegionDwell({
    enabled: coarseStageActive,
    gazePoint: gaze.state.gazePoint,
    divisions: COARSE_DIVISIONS,
    dwellTime: accessibility.dwellTime,
    onCommit: (picked) => {
      const current = zoomRegionRef.current ?? { row: 0, col: 0, size: FULL_REGION }
      const half = current.size / COARSE_DIVISIONS
      const next = {
        row: current.row + picked.row * half,
        col: current.col + picked.col * half,
        size: half,
      }
      noteProgress()

      if (half > 1) {
        setZoomRegion(next)
        return
      }

      // Down to a single cell: that is the square, in drawing order. Acting on
      // it here rather than waiting for a blink is deliberate — three deliberate
      // dwells are already an unambiguous statement of intent, and it removes
      // blink detection from the critical path of every move.
      setZoomRegion(null)
      const square = toLogical({ row: next.row, col: next.col }, orientation)
      commitGazeSquare(square)
    },
  })

  /** Current region, read inside the commit handler without re-arming the dwell. */
  const zoomRegionRef = useRef(zoomRegion)
  zoomRegionRef.current = zoomRegion

  const {
    rawSquare,
    stableSquare,
    dwellSquare,
    dwellProgress,
    confidence: dwellConfidence,
    onBoard: gazeOnBoard,
  } = useGazeInteraction({
    enabled: fineStageActive,
    gazePoint: gaze.state.gazePoint,
    rawGazePoint: gaze.state.rawGazePoint,
    dwellTime: accessibility.dwellTime,
    calibrationScore: gaze.calibrationModel?.qualityScore ?? 0,
    registerBlink: gaze.onBlink,
    onDwell: handleGazeDwell,
    onBlinkConfirm: handleBlinkConfirm,
  })

  /**
   * Looking away is how you cancel a zoom. There is no reachable "back" control
   * for someone using only their eyes — a button would need the very precision
   * the zoom exists to avoid needing — so the gesture is simply to look off the
   * board, which is also what a player does naturally when they change their
   * mind about which side of the board they were considering.
   */
  useEffect(() => {
    if (!zoomRegion || !gazeControlReady || regionOnBoard) return
    const id = setTimeout(() => {
      // Back out one level per pause rather than all the way to the full board:
      // overshooting by one quarter is the common mistake, and undoing it should
      // cost one look, not the whole descent.
      setZoomRegion((current) => {
        if (!current) return null
        const size = current.size * COARSE_DIVISIONS
        if (size >= FULL_REGION) return null
        const snap = (v: number) => Math.floor(v / size) * size
        return { row: snap(current.row), col: snap(current.col), size }
      })
    }, ZOOM_CANCEL_MS)
    return () => clearTimeout(id)
  }, [zoomRegion, regionOnBoard, gazeControlReady])

  // Mouse fallback: click to select, click again to move.
  const handleSquareClick = (row: number, col: number) => {
    if (!isHumanTurn) return
    // Reaching for the mouse is not being stuck, so it clears the watchdog.
    noteProgress()
    setGameState((prev) => {
      const selectedSquare = prev.selectedSquare
      const clickedPiece = getPieceAt(prev.board, row, col)

      if (!selectedSquare) {
        if (clickedPiece && clickedPiece.color === (prev.whiteToMove ? 'white' : 'black')) {
          return { ...prev, selectedSquare: { row, col } }
        }
        return prev
      }

      if (selectedSquare.row === row && selectedSquare.col === col) {
        return { ...prev, selectedSquare: null }
      }

      if (clickedPiece && clickedPiece.color === (prev.whiteToMove ? 'white' : 'black')) {
        return { ...prev, selectedSquare: { row, col } }
      }

      const newGameState = makeMove(prev, selectedSquare, { row, col })
      if (newGameState) {
        return newGameState
      }

      return prev
    })
  }

  const handleNewGame = () => {
    setGameState(createInitialGameState())
    setTimer(600)
    setResultDismissed(false)
  }

  const handleRestartGame = handleNewGame

  const handleSettings = () => {
    setSettingsOpen(true)
  }

  return (
    <div
      ref={rootRef}
      className="min-h-screen lg:h-screen lg:overflow-hidden bg-background flex flex-col"
    >
      {/* Hidden webcam element WebEyeTrack drives by id. Always mounted while the
          page is (kept renderable, not display:none, so frame capture never
          breaks); shown as a small corner preview in gaze mode. */}
      <video
        ref={gaze.videoRef}
        id="webcam"
        autoPlay
        playsInline
        muted
        className={
          isFullscreen
            ? 'fixed bottom-3 left-3 z-[65] w-40 h-28 object-cover -scale-x-100 rounded-lg border border-border opacity-80 pointer-events-none'
            : 'fixed w-px h-px opacity-0 pointer-events-none -z-10'
        }
      />

      {/* Accessibility Settings Menu */}
      <AccessibilityMenu
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={accessibility}
        onSettingsChange={setAccessibility}
      />

      {/* End-of-game announcement. Lives inside the fullscreen root so it is
          still visible while playing with the eyes. */}
      <GameOverModal
        outcome={outcome}
        open={!!outcome && !resultDismissed}
        onRematch={handleNewGame}
        onDismiss={() => setResultDismissed(true)}
        moveCount={gameState.moves.length}
      />

      {/* Top Navigation — hidden in gaze/focus mode to hand its height to the board. */}
      {!focusMode && <TopNav />}

      {/* Full-screen gaze cursor. Only meaningful while gaze is actually driving,
          i.e. in fullscreen eye control. */}
      <GazeCursor
        gazePoint={gaze.state.correctedGazePoint}
        active={isFullscreen && gaze.isReady && gaze.state.status === 'active'}
        dwellProgress={dwellProgress}
        dwelling={!!dwellSquare}
        largeCursor={accessibility.largeCursor}
        reducedMotion={accessibility.reducedMotion}
      />

      <GazeDebugOverlay
        active={debugGaze && isFullscreen && gaze.isReady}
        state={eyeTrackingState}
        rawSquare={rawSquare}
        stableSquare={stableSquare}
        confidence={dwellConfidence}
        fixationProgress={dwellProgress}
        onBoard={gazeOnBoard}
      />

      {/* Setup instructions before the dots, and how-to-play after them. */}
      <GazeGuideOverlay
        open={isFullscreen && guide !== null}
        variant={guide ?? 'how-to-play'}
        reason={guideReason}
        onContinue={() => {
          const current = guide
          setGuide(null)
          noteProgress()
          if (current === 'before-calibration') setShowCalibration(true)
        }}
        onRecalibrate={restartCalibration}
        onCancel={() => {
          setGuide(null)
          exitEyeControl()
        }}
      />

      {/* Calibration overlay (only in gaze mode, until calibrated). */}
      {isFullscreen && showCalibration && (
        <CalibrationOverlay
          rawGazePointRef={gaze.rawGazePointRef}
          headPoseRef={gaze.headPoseRef}
          feedAdaptationPoint={gaze.feedAdaptationPoint}
          ownsAdaptationRef={gaze.ownsAdaptationRef}
          onProgress={(completed, total) => {
            setCalibrationProgress((completed / total) * 100)
          }}
          onComplete={(model) => {
            gaze.setCalibrationModel(model)
            setCalibrationProgress(100)
            setShowCalibration(false)
            // The client's second note: explain how to actually play, once the
            // eyes are calibrated and before the first move is attempted.
            noteProgress()
            setGuideReason('first-time')
            setGuide('how-to-play')
          }}
          onCancel={() => {
            setShowCalibration(false)
          }}
        />
      )}

      {/* Why the last blink did nothing. Bright and large — it is read from
          across the room, mid-game, by someone who cannot use a mouse. */}
      {isFullscreen && hint && !guide && !showCalibration && boardBigEnough && (
        <div className="fixed top-4 left-1/2 z-[66] w-[min(92vw,42rem)] -translate-x-1/2 rounded-xl border-2 border-[#ffd24a] bg-[#0d1117] px-5 py-3 text-center text-lg font-semibold text-[#ffd24a] shadow-lg">
          {hint}
        </div>
      )}

      {/* What is driving the board and how to change it. In fullscreen every
          other affordance is gone, so the two keys that rescue a bad session —
          swap tracker, turn two-step selection off — have to be visible. */}
      {isFullscreen && !guide && !showCalibration && (
        <div className="fixed top-3 left-3 z-[60] flex items-center gap-3 rounded-lg border border-white/25 bg-[#0d1117]/90 px-3 py-1.5 text-sm text-[#c3cede]">
          <span className="font-semibold text-white">
            {GAZE_SOURCE_LABELS[gaze.sourceKind]}
          </span>
          <span className="text-white/30">|</span>
          <span>
            {coarseToFine
              ? zoomRegion
                ? zoomRegion.size > COARSE_DIVISIONS
                  ? 'narrow it down'
                  : 'pick the square'
                : 'pick a quarter'
              : 'direct'}
          </span>
          <span className="text-white/30">|</span>
          <span className="text-[#9fb0c6]">T tracker · Z two-step · C recalibrate</span>
        </div>
      )}

      {/* We changed estimators for them; without saying so the calibration
          prompt that follows looks like the app forgetting itself. */}
      {isFullscreen && gaze.autoSwitched && !guide && (
        <div className="fixed top-14 left-1/2 z-[66] w-[min(92vw,42rem)] -translate-x-1/2 rounded-xl border-2 border-[#7fd4ff] bg-[#0d1117] px-5 py-3 text-center text-base font-semibold text-[#7fd4ff] shadow-lg">
          The first eye tracker produced no usable signal, so we switched to{' '}
          {GAZE_SOURCE_LABELS[gaze.sourceKind]}. Press C to calibrate it.
        </div>
      )}

      {/* Head has left the pose calibration was collected at. The mapping cannot
          be repaired without new ground truth, so say so plainly instead of
          letting the board quietly stop obeying. */}
      {isFullscreen && !guide && !showCalibration && gazeControlReady && headMoved && (
        <div className="fixed bottom-24 left-1/2 z-[66] w-[min(92vw,42rem)] -translate-x-1/2 rounded-xl border-2 border-[#ff9d42] bg-[#0d1117] px-5 py-3 text-center text-lg font-semibold text-[#ff9d42] shadow-lg">
          You have moved since calibrating — sit back where you were, or press C to recalibrate.
        </div>
      )}

      {/* "Board too small for gaze" nudge — rare, since fullscreen clears the bar. */}
      {isFullscreen && gaze.isReady && !showCalibration && !boardBigEnough && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[66] flex items-center gap-2 rounded-lg border border-yellow-400/40 bg-card/90 px-3 py-2 text-xs text-yellow-400 shadow-lg">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>Enlarge the window — squares must be ≥{MIN_GAZE_SQUARE_PX}px for eye control.</span>
        </div>
      )}

      {/* Board flip. */}
      <button
        onClick={() =>
          setOrientation((o) => (o === 'white-top' ? 'white-bottom' : 'white-top'))
        }
        title={
          orientation === 'white-top'
            ? 'Flip board — put white at the bottom (V)'
            : 'Flip board — put white at the top (V)'
        }
        aria-label="Flip board orientation"
        className="fixed bottom-3 right-14 z-50 p-2 rounded-lg border border-border bg-card/80 backdrop-blur text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
      >
        <FlipVertical2 className="w-4 h-4" />
      </button>

      {/* Eye-control / fullscreen toggle. */}
      <button
        onClick={() => (document.fullscreenElement ? exitEyeControl() : enterEyeControl())}
        title={
          isFullscreen ? 'Exit eye control (Esc)' : 'Eye control — fullscreen, gaze on (F)'
        }
        aria-label={isFullscreen ? 'Exit eye control' : 'Enter eye control'}
        aria-pressed={isFullscreen}
        className="fixed bottom-3 right-3 z-50 p-2 rounded-lg border border-border bg-card/80 backdrop-blur text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
      >
        {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
      </button>

      {/* Main Game Area */}
      <div
        className={`flex-1 flex overflow-hidden lg:min-h-0 ${
          focusMode ? 'gap-0 p-0' : 'gap-3 p-3'
        }`}
      >
        {/* Left Sidebar - Controls (collapsible on lg+, hidden in focus mode) */}
        {focusMode ? null : leftOpen ? (
          <div className="w-56 hidden lg:flex flex-col shrink-0 lg:min-h-0 lg:overflow-y-auto custom-scrollbar">
            <div className="flex justify-end mb-2">
              <button
                onClick={() => setLeftOpen(false)}
                title="Collapse panel"
                aria-label="Collapse controls panel"
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1">
              <LeftSidebar
                difficulty={difficulty}
                timer={timer}
                onNewGame={handleNewGame}
                onRestartGame={handleRestartGame}
                onSettings={handleSettings}
              />
            </div>
          </div>
        ) : (
          <button
            onClick={() => setLeftOpen(true)}
            title="Show controls"
            aria-label="Show controls panel"
            className="hidden lg:flex items-center justify-center w-6 shrink-0 rounded-md border border-border bg-card/40 text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}

        {/* Center - Chessboard. */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
          className="flex-1 min-w-0 min-h-0 flex items-stretch justify-center"
        >
          <Chessboard
            gameState={gameState}
            onSquareClick={handleSquareClick}
            dwellSquare={dwellSquare}
            dwellProgress={dwellProgress}
            dwellConfidence={dwellConfidence}
            isThinking={engineThinking}
            focusMode={focusMode}
            layoutKey={`${leftOpen}-${rightOpen}`}
            orientation={orientation}
            zoomRegion={zoomRegion}
            pendingRegion={
              coarseStageActive && pendingRegion
                ? { ...pendingRegion, divisions: COARSE_DIVISIONS }
                : null
            }
            regionDepth={zoomRegion ? Math.log2(FULL_REGION / zoomRegion.size) : 0}
            pendingProgress={regionProgress}
          />
        </motion.div>

        {/* Right Sidebar - Eye Tracking & Move History (hidden in focus mode) */}
        {focusMode ? null : rightOpen ? (
          <div className="w-72 hidden lg:flex gap-4 flex-col shrink-0 lg:min-h-0 lg:overflow-y-auto custom-scrollbar">
            <div className="flex justify-start shrink-0">
              <button
                onClick={() => setRightOpen(false)}
                title="Collapse panel"
                aria-label="Collapse tracking panel"
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="shrink-0">
              <EyeTrackingPanel
                eyeTrackingState={eyeTrackingState}
                onStartEyeControl={enterEyeControl}
                onRecalibrate={restartCalibration}
                onToggleDebug={() => setDebugGaze((enabled) => !enabled)}
                debugEnabled={debugGaze}
                isReady={gaze.isReady}
                error={gaze.error}
                hasCalibration={gaze.hasCalibration}
                calibrationSampleCount={gaze.calibrationSampleCount}
                targetSquare={dwellSquare ? toAlgebraic(dwellSquare) : null}
                targetConfidence={dwellConfidence}
                cameraResolution={gaze.cameraResolution}
                fps={gaze.fps}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <MoveHistoryPanel moves={gameState.moves} />
            </div>
          </div>
        ) : (
          <button
            onClick={() => setRightOpen(true)}
            title="Show tracking & history"
            aria-label="Show tracking and history panel"
            className="hidden lg:flex items-center justify-center w-6 shrink-0 rounded-md border border-border bg-card/40 text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Mobile Layout - Stacked */}
      <div
        className={`px-4 py-4 space-y-4 border-t border-border ${
          focusMode ? 'hidden' : 'lg:hidden'
        }`}
      >
        <LeftSidebar
          difficulty={difficulty}
          timer={timer}
          onNewGame={handleNewGame}
          onRestartGame={handleRestartGame}
          onSettings={handleSettings}
        />
        <div className="grid grid-cols-2 gap-4">
          <EyeTrackingPanel
            eyeTrackingState={eyeTrackingState}
            onStartEyeControl={enterEyeControl}
            onRecalibrate={restartCalibration}
            onToggleDebug={() => setDebugGaze((enabled) => !enabled)}
            debugEnabled={debugGaze}
            isReady={gaze.isReady}
            error={gaze.error}
            hasCalibration={gaze.hasCalibration}
            calibrationSampleCount={gaze.calibrationSampleCount}
            targetSquare={dwellSquare ? toAlgebraic(dwellSquare) : null}
            targetConfidence={dwellConfidence}
            cameraResolution={gaze.cameraResolution}
            fps={gaze.fps}
          />
          <MoveHistoryPanel moves={gameState.moves} />
        </div>
      </div>
    </div>
  )
}
