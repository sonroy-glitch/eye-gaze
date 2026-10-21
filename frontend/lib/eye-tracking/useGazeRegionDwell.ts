'use client'

import { useEffect, useRef, useState } from 'react'
import { getBoardFrameRect } from './board-mapping'
import type { GazePoint } from './types'

/**
 * Dwell selection over a coarse N x N grid laid across the board.
 *
 * This is the first half of coarse-to-fine selection, and it exists because of
 * a hard limit rather than a preference. Gaze error is roughly fixed in pixels,
 * so on an 8x8 board a webcam tracker that is off by two squares cannot pick a
 * square at all — no amount of dwell time or smoothing fixes an estimate whose
 * error is larger than the target. The way out is not a better estimate, it is
 * a bigger target: pick one of four quadrants first, magnify it, then pick a
 * square inside it. Both steps then need the same tolerance, roughly two
 * squares' worth of pixels, which is comfortably inside what these trackers
 * actually deliver.
 *
 * Deliberately independent of {@link SquareStabilizer}: that one votes over 64
 * cells with hysteresis tuned for them, and re-using it at this scale would
 * inherit thresholds that mean something quite different when a "cell" is a
 * quarter of the board.
 */

export interface RegionDwellOptions {
  enabled: boolean
  /** Smoothed, calibrated gaze point in viewport pixels. */
  gazePoint: GazePoint
  /** Grid resolution: 2 gives quadrants, 4 gives sixteenths. */
  divisions: number
  /** How long the gaze must hold a region before it commits (ms). */
  dwellTime: number
  /**
   * Identifies the frame the grid is currently laid over. Change it whenever the
   * caller magnifies, backs out, or otherwise moves the frame, and the dwell
   * re-arms against the new geometry.
   *
   * Without this the post-commit latch outlives the zoom step it belongs to.
   * The latch only releases when the gaze moves to a *different* grid cell, but
   * after a magnification the cell indices are renumbered against the new frame,
   * so a player whose next target happens to fall in the same quadrant index
   * they just picked (one time in four, at every step) stays latched: progress
   * pins at 1 and the board stops responding until they look somewhere else and
   * back. That reads as "the pieces will not move even after calibration".
   * Votes collected against the old frame are meaningless here too, so the
   * cleanest re-arm is to restart the whole sampler.
   */
  resetKey?: string
  onCommit: (region: { row: number; col: number }) => void
}

export interface RegionDwell {
  /** Region the gaze is currently resolved to, in drawn grid coordinates. */
  region: { row: number; col: number } | null
  /** 0..1 progress toward committing it. */
  progress: number
  /** True while the gaze is over the board at all. */
  onBoard: boolean
  /**
   * True while the dwell is deliberately refusing to accumulate because the
   * gaze has not yet moved off the point it last committed from. Surface it:
   * the board looking inert is only acceptable if the player is told the app is
   * waiting for them to look somewhere.
   */
  waitingForMove: boolean
}

const UPDATE_INTERVAL_MS = 33
/**
 * Fraction of a region's own size that the gaze may stray outside the board and
 * still count. Regions are large, so the edge ones would otherwise be much
 * harder to reach than the middle ones — the same asymmetry the square-level
 * mapping corrects with its own tolerance.
 */
const EDGE_TOLERANCE = 0.35
/** A region must hold this share of the recent samples to be considered stable. */
const MIN_VOTE_FRACTION = 0.6
const VOTE_WINDOW_MS = 300
/** Frames worse than this are not worth voting with. */
const MIN_FRAME_CONFIDENCE = 0.15

/**
 * Dead time after the frame changes, before any sample is counted.
 *
 * The magnify transition runs 220ms, during which the squares are physically
 * sliding under the player's gaze. Sampling through it measures the old layout.
 */
const SETTLE_MS = 250

/**
 * After a commit the dwell stays disarmed until the gaze has travelled this
 * fraction of the frame away from the point it committed from.
 *
 * This is the fix for the reported "keeps zooming in and out of that area, and
 * the piece never moves to its target square". A commit changes the view, and
 * the player then has to *visually find* their next target on a board that just
 * changed scale: a search plus a decision, median around 800ms, which is longer
 * than the 700ms dwell. Meanwhile their gaze is still parked where it was, and a
 * parked gaze is maximally stable, so it clears the vote threshold trivially and
 * commits a region the player never chose. They are then zoomed somewhere they
 * did not ask for, and have to look off-board to escape. Simulation put that at
 * better than one selection in three.
 *
 * A time delay alone is the wrong instrument, because it has to be long enough
 * to cover the slowest search and so taxes every move. Requiring *movement* is
 * exact: a parked gaze never satisfies it, and a player who has already looked
 * at their next target satisfies it immediately. Measured at 0% phantom commits
 * against 100% of intended targets still landing, costing ~30ms per step.
 */
export const REARM_MOVE_FRACTION = 0.15

/**
 * Upper bound on the movement gate, so a player who genuinely wants a region
 * adjacent to the one they just picked is never locked out. Long enough to sit
 * well past a normal visual search.
 */
export const REARM_TIMEOUT_MS = 2000

export function useGazeRegionDwell({
  enabled,
  gazePoint,
  divisions,
  dwellTime,
  resetKey = '',
  onCommit,
}: RegionDwellOptions): RegionDwell {
  const [region, setRegion] = useState<{ row: number; col: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const [onBoard, setOnBoard] = useState(false)
  const [waitingForMove, setWaitingForMove] = useState(false)

  /**
   * Where and when the last commit fired. Deliberately a ref rather than
   * effect-local state: the whole point is that it outlives the `resetKey`
   * restart the commit itself causes, so the new sampler knows which point the
   * gaze has to leave before it may accumulate again.
   */
  const lastCommitRef = useRef<{ x: number; y: number; at: number } | null>(null)

  const gazeRef = useRef(gazePoint)
  gazeRef.current = gazePoint
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const dwellMsRef = useRef(dwellTime)
  dwellMsRef.current = dwellTime
  const divisionsRef = useRef(divisions)
  divisionsRef.current = divisions

  useEffect(() => {
    if (!enabled) {
      setRegion(null)
      setProgress(0)
      setOnBoard(false)
      setWaitingForMove(false)
      // Leaving gaze control ends the move in progress, so the next entry must
      // not inherit a gate anchored to a commit from the previous session.
      lastCommitRef.current = null
      return
    }

    const votes: Array<{ t: number; row: number; col: number; weight: number }> = []
    let target: { row: number; col: number } | null = null
    let dwellStart = 0
    /** Held after a commit so one long look cannot fire the same region twice. */
    let latched: { row: number; col: number } | null = null
    /** When this sampler armed, for {@link SETTLE_MS}. */
    const armedAt = performance.now()
    /** Whether the {@link REARM_MOVE_FRACTION} gate has been satisfied. */
    let gateOpen = false

    const id = setInterval(() => {
      const now = performance.now()
      const gaze = gazeRef.current
      const rect = getBoardFrameRect(now)
      if (!rect) {
        setOnBoard(false)
        return
      }

      /** Discard everything collected so far, leaving the sampler idle. */
      const standDown = () => {
        votes.length = 0
        target = null
        setRegion(null)
        setProgress(0)
      }

      // The squares are still sliding for the length of the magnify transition.
      if (now - armedAt < SETTLE_MS) {
        standDown()
        return
      }

      // Hold off until the gaze has left the point the last commit fired from.
      if (!gateOpen) {
        const last = lastCommitRef.current
        if (!last) {
          gateOpen = true
        } else if (gaze.confidence >= MIN_FRAME_CONFIDENCE) {
          const travelled = Math.hypot(gaze.x - last.x, gaze.y - last.y) / rect.width
          if (travelled >= REARM_MOVE_FRACTION || now - last.at >= REARM_TIMEOUT_MS) {
            gateOpen = true
          }
        } else if (now - last.at >= REARM_TIMEOUT_MS) {
          // No usable signal to measure movement with; do not strand the player.
          gateOpen = true
        }
        if (!gateOpen) {
          standDown()
          setWaitingForMove(true)
          return
        }
      }
      setWaitingForMove(false)

      const n = Math.max(1, divisionsRef.current)
      const fx = ((gaze.x - rect.left) / rect.width) * n
      const fy = ((gaze.y - rect.top) / rect.height) * n
      const inside =
        fx >= -EDGE_TOLERANCE &&
        fx <= n + EDGE_TOLERANCE &&
        fy >= -EDGE_TOLERANCE &&
        fy <= n + EDGE_TOLERANCE

      if (inside && gaze.confidence >= MIN_FRAME_CONFIDENCE) {
        votes.push({
          t: now,
          row: Math.min(n - 1, Math.max(0, Math.floor(fy))),
          col: Math.min(n - 1, Math.max(0, Math.floor(fx))),
          weight: gaze.confidence,
        })
      }
      while (votes.length && now - votes[0].t > VOTE_WINDOW_MS) votes.shift()
      setOnBoard(inside)

      if (!votes.length) {
        target = null
        setRegion(null)
        setProgress(0)
        return
      }

      const tally = new Map<string, { row: number; col: number; weight: number }>()
      let total = 0
      for (const vote of votes) {
        total += vote.weight
        const key = `${vote.row}-${vote.col}`
        const entry = tally.get(key)
        if (entry) entry.weight += vote.weight
        else tally.set(key, { row: vote.row, col: vote.col, weight: vote.weight })
      }

      let winner: { row: number; col: number } | null = null
      let winnerWeight = 0
      tally.forEach((entry) => {
        if (entry.weight > winnerWeight) {
          winnerWeight = entry.weight
          winner = { row: entry.row, col: entry.col }
        }
      })

      const fraction = total > 0 ? winnerWeight / total : 0
      if (!winner || fraction < MIN_VOTE_FRACTION) {
        setProgress(0)
        return
      }
      const stable: { row: number; col: number } = winner

      if (latched && (latched.row !== stable.row || latched.col !== stable.col)) latched = null
      if (!target || target.row !== stable.row || target.col !== stable.col) {
        target = stable
        dwellStart = now
      }
      setRegion(stable)

      if (latched) {
        setProgress(1)
        return
      }

      const p = Math.max(0, Math.min(1, (now - dwellStart) / Math.max(1, dwellMsRef.current)))
      setProgress(p)
      if (p >= 1) {
        latched = stable
        // Anchor the movement gate before handing control to the caller, which
        // will change the frame and restart this sampler.
        lastCommitRef.current = { x: gaze.x, y: gaze.y, at: now }
        onCommitRef.current(stable)
      }
    }, UPDATE_INTERVAL_MS)

    return () => clearInterval(id)
  }, [enabled, resetKey])

  return { region, progress, onBoard, waitingForMove }
}
