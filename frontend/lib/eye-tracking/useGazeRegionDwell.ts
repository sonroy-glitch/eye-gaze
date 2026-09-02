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
  onCommit: (region: { row: number; col: number }) => void
}

export interface RegionDwell {
  /** Region the gaze is currently resolved to, in drawn grid coordinates. */
  region: { row: number; col: number } | null
  /** 0..1 progress toward committing it. */
  progress: number
  /** True while the gaze is over the board at all. */
  onBoard: boolean
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

export function useGazeRegionDwell({
  enabled,
  gazePoint,
  divisions,
  dwellTime,
  onCommit,
}: RegionDwellOptions): RegionDwell {
  const [region, setRegion] = useState<{ row: number; col: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const [onBoard, setOnBoard] = useState(false)

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
      return
    }

    const votes: Array<{ t: number; row: number; col: number; weight: number }> = []
    let target: { row: number; col: number } | null = null
    let dwellStart = 0
    /** Held after a commit so one long look cannot fire the same region twice. */
    let latched: { row: number; col: number } | null = null

    const id = setInterval(() => {
      const now = performance.now()
      const gaze = gazeRef.current
      const rect = getBoardFrameRect(now)
      if (!rect) {
        setOnBoard(false)
        return
      }

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
        onCommitRef.current(stable)
      }
    }, UPDATE_INTERVAL_MS)

    return () => clearInterval(id)
  }, [enabled])

  return { region, progress, onBoard }
}
