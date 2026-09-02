import { BOARD_SIZE, COLUMN_LABELS } from '@/lib/chess/constants'
import type { BoardPosition } from '@/lib/chess/types'
import {
  DEFAULT_ORIENTATION,
  isOrientation,
  toLogical,
  toVisual,
  type BoardOrientation,
} from '@/lib/chess/orientation'

/**
 * Chessboard <-> gaze coordinate mapping.
 *
 * The board is not a fixed rectangle: it resizes with the viewport and grows
 * when the side panels collapse. So rather than hit-testing the DOM with
 * `elementFromPoint` (which returns whatever happens to be painted on top, and
 * gives no notion of "how close to the middle of the square"), we read the
 * board's live bounding rectangle and do the arithmetic ourselves. That gives us
 * the sub-square offset the confidence estimate needs, and it keeps working when
 * an overlay sits above the board.
 */

export interface BoardGeometry {
  /** Viewport-space rect of the 8x8 playing area (labels excluded). */
  left: number
  top: number
  width: number
  height: number
  /** Edge length of one square in CSS pixels. */
  squareSize: number
  /**
   * Which way round the board is drawn. Screen position alone cannot say which
   * square a point falls on — the top-left cell is a8 in one orientation and h1
   * in the other — so the mapping has to know.
   */
  orientation: BoardOrientation
}

/** Serialisable rect stored alongside a calibration model. */
export interface BoardRect {
  left: number
  top: number
  width: number
  height: number
}

const BOARD_SELECTOR = '[data-chessboard]'
/**
 * The board's *layout* box, which does not move when the grid inside it is
 * magnified for coarse-to-fine selection.
 *
 * Two rects are needed once the board can zoom. Hit-testing must use the
 * transformed grid — that is what the player is actually looking at — while
 * calibration must use this one, because a calibration model is anchored to
 * where the board sat when it was fitted, and re-anchoring it onto a magnified
 * grid would stretch every prediction by the zoom factor.
 */
const BOARD_FRAME_SELECTOR = '[data-chessboard-frame]'

/**
 * Measure the playing area.
 *
 * This reads the board element itself rather than locating two corner *squares*.
 * The earlier version assumed square a8 sat at the top-left, which stops being
 * true the moment the board can be flipped — it would have measured from
 * whichever corner a8 had moved to and produced a rect with negative width.
 */
export function readBoardGeometry(): BoardGeometry | null {
  if (typeof document === 'undefined') return null
  const board = document.querySelector(BOARD_SELECTOR)
  if (!board) return null

  const rect = board.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null

  const declared = board.getAttribute('data-orientation')
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    squareSize: rect.width / BOARD_SIZE,
    orientation: isOrientation(declared) ? declared : DEFAULT_ORIENTATION,
  }
}

/** Layout box of the board, ignoring any zoom transform on the grid. */
export function readBoardFrameRect(): BoardRect | null {
  if (typeof document === 'undefined') return null
  const frame = document.querySelector(BOARD_FRAME_SELECTOR)
  // Falling back to the grid keeps every caller working when the board is not
  // zoomed, which is the only state the frame element did not exist for.
  const element = frame ?? document.querySelector(BOARD_SELECTOR)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

let cachedFrame: BoardRect | null = null
let cachedFrameAt = 0

export function getBoardFrameRect(now = performance.now()): BoardRect | null {
  if (cachedFrame && now - cachedFrameAt < GEOMETRY_TTL_MS) return cachedFrame
  cachedFrame = readBoardFrameRect()
  cachedFrameAt = now
  return cachedFrame
}

let cached: BoardGeometry | null = null
let cachedAt = 0
const GEOMETRY_TTL_MS = 250

/**
 * Board geometry with a short TTL. The detection loop runs at frame rate and
 * `getBoundingClientRect` forces layout, so re-measuring every frame would cost
 * more than the board can possibly move in 250ms.
 */
export function getBoardGeometry(now = performance.now()): BoardGeometry | null {
  if (cached && now - cachedAt < GEOMETRY_TTL_MS) return cached
  cached = readBoardGeometry()
  cachedAt = now
  return cached
}

/** Force the next read to re-measure (call after a layout change). */
export function invalidateBoardGeometry(): void {
  cached = null
  cachedAt = 0
  cachedFrame = null
  cachedFrameAt = 0
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', invalidateBoardGeometry)
}

export function toBoardRect(geom: BoardGeometry): BoardRect {
  return { left: geom.left, top: geom.top, width: geom.width, height: geom.height }
}

/** Centre of a logical square in viewport pixels, accounting for orientation. */
export function squareCenter(
  geom: BoardGeometry,
  row: number,
  col: number,
): { x: number; y: number } {
  const cell = toVisual({ row, col }, geom.orientation)
  return {
    x: geom.left + (cell.col + 0.5) * (geom.width / BOARD_SIZE),
    y: geom.top + (cell.row + 0.5) * (geom.height / BOARD_SIZE),
  }
}

/** Map a fraction of the board rect (0..1 on each axis) to viewport pixels. */
export function boardFractionToViewport(
  geom: BoardGeometry,
  fx: number,
  fy: number,
): { x: number; y: number } {
  return { x: geom.left + fx * geom.width, y: geom.top + fy * geom.height }
}

export interface SquareHit {
  /** The logical square, independent of how the board is drawn. */
  square: BoardPosition
  /** The cell it is drawn at. Equal to `square` only when white is at the bottom. */
  cell: BoardPosition
  /** Distance from the square's centre, in units of one square edge. */
  centerDistance: number
  /**
   * Board-relative coordinates in *drawing* space, 0..8 along each axis (may
   * fall outside). The stabilizer only ever compares these to each other, so
   * drawing space is the right frame — it is what the eye actually traverses.
   */
  fileCoord: number
  rankCoord: number
}

/**
 * Resolve a viewport point to a square.
 *
 * `tolerance` is how far outside the board (in squares) a point may fall and
 * still be clamped onto the edge square. A small tolerance is what keeps the
 * a-file and the back rank usable: gaze error is roughly constant in pixels, so
 * edge squares would otherwise be systematically under-selected.
 */
export function pointToSquare(
  x: number,
  y: number,
  geom: BoardGeometry,
  tolerance = 0.5,
): SquareHit | null {
  const fileCoord = ((x - geom.left) / geom.width) * BOARD_SIZE
  const rankCoord = ((y - geom.top) / geom.height) * BOARD_SIZE

  if (
    fileCoord < -tolerance ||
    fileCoord > BOARD_SIZE + tolerance ||
    rankCoord < -tolerance ||
    rankCoord > BOARD_SIZE + tolerance
  ) {
    return null
  }

  // Which cell was looked at, in drawing order...
  const cellCol = Math.min(BOARD_SIZE - 1, Math.max(0, Math.floor(fileCoord)))
  const cellRow = Math.min(BOARD_SIZE - 1, Math.max(0, Math.floor(rankCoord)))
  const centerDistance = Math.hypot(
    fileCoord - (cellCol + 0.5),
    rankCoord - (cellRow + 0.5),
  )

  // ...and the square that cell is currently showing.
  const square = toLogical({ row: cellRow, col: cellCol }, geom.orientation)

  return { square, cell: { row: cellRow, col: cellCol }, centerDistance, fileCoord, rankCoord }
}

/** `{row: 0, col: 0}` is a8 — row 0 is the top rank as rendered. */
export function toAlgebraic(pos: BoardPosition): string {
  const file = COLUMN_LABELS[pos.col] ?? '?'
  return `${file}${BOARD_SIZE - pos.row}`
}

export function sameSquare(a: BoardPosition | null, b: BoardPosition | null): boolean {
  return !!a && !!b && a.row === b.row && a.col === b.col
}

/**
 * How much larger (or smaller) the board is now than when it was calibrated.
 * Returns 1 when they match, or null when either rect is unknown.
 *
 * `remapForBoard` keeps a modest layout shift honest, but it cannot rescue a
 * large one: play-time gaze angles then fall outside the range the model was
 * ever shown, and the prediction becomes extrapolation. Past roughly 15% the
 * only real fix is to calibrate again at the size being played on.
 */
export function boardScaleRatio(from: BoardRect | null, to: BoardRect | null): number | null {
  if (!from || !to || !(from.width > 0) || !(to.width > 0)) return null
  return to.width / from.width
}

/**
 * Re-anchor a gaze prediction from the board rect it was calibrated against to
 * the board's current rect. Calibration targets were placed relative to the
 * board, so when the board moves or resizes (a side panel collapses, the window
 * is resized) the whole mapping should follow it instead of forcing the user to
 * recalibrate. Falls back to the identity when either rect is unusable.
 */
export function remapForBoard(
  point: { x: number; y: number },
  from: BoardRect | null,
  to: BoardRect | null,
): { x: number; y: number } {
  if (!from || !to) return point
  if (!(from.width > 0) || !(from.height > 0)) return point

  const sx = to.width / from.width
  const sy = to.height / from.height
  // Ignore imperceptible differences so a 1px layout shimmer can't add noise.
  if (
    Math.abs(sx - 1) < 0.005 &&
    Math.abs(sy - 1) < 0.005 &&
    Math.abs(to.left - from.left) < 2 &&
    Math.abs(to.top - from.top) < 2
  ) {
    return point
  }

  return {
    x: to.left + (point.x - from.left) * sx,
    y: to.top + (point.y - from.top) * sy,
  }
}
