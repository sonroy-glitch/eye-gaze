'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { GameState, BoardPosition } from '@/lib/chess/types'
import { BOARD_COLORS, BOARD_SIZE, COLUMN_LABELS } from '@/lib/chess/constants'
import { getLegalMoves } from '@/lib/chess/engine'
import type { GameStatus } from '@/lib/chess/types'
import { describeOutcome } from '@/lib/chess/outcome'
import {
  DEFAULT_ORIENTATION,
  toLogical,
  type BoardOrientation,
} from '@/lib/chess/orientation'
import { useMaxSquareSize } from '@/lib/game/useMaxSquareSize'
import Square from './Square'

interface ChessboardProps {
  gameState: GameState
  onSquareClick: (row: number, col: number) => void
  /** Square currently being dwelled on via gaze, if any. */
  dwellSquare?: BoardPosition | null
  /** 0..1 progress of the current dwell. */
  dwellProgress?: number
  /** 0..1 confidence that the dwelled square is the one being looked at. */
  dwellConfidence?: number
  /** True while the engine (Black) is computing its move. */
  isThinking?: boolean
  /** Strip the frame and inset so the board can claim the last few pixels. */
  focusMode?: boolean
  /**
   * Changes whenever the surrounding layout does (panels collapsing, focus mode)
   * so the board re-measures instead of waiting for an observer that embedded
   * viewers may never fire.
   */
  layoutKey?: string
  /** Which way round to draw the board. Purely presentational. */
  orientation?: BoardOrientation
  /**
   * Magnify one square block of the board to fill the frame, in *drawn* cell
   * coordinates. This is the second half of coarse-to-fine gaze selection: the
   * grid is scaled about the block's corner so each square covers several times
   * the pixels, which is what brings square-level selection inside the accuracy
   * a webcam tracker can actually deliver.
   */
  zoomRegion?: { row: number; col: number; size: number } | null
  /** Coarse region being dwelled on before zooming in, drawn as a target. */
  pendingRegion?: { row: number; col: number; divisions: number } | null
  /** 0..1 dwell progress on {@link pendingRegion}. */
  pendingProgress?: number
  /** How many times the board has been halved, for the "you are here" readout. */
  regionDepth?: number
}

/**
 * Upper bound on the board's edge, in CSS pixels.
 *
 * Bigger is not indefinitely better. Gaze error is angular, so a larger board
 * enlarges the error and the target in equal measure — measured across sizes,
 * accuracy in *squares* is essentially flat. What a bigger board does buy is
 * headroom over the error sources that are fixed in pixels (the cursor
 * deadband, landmark quantisation) and far easier reading. Past roughly this
 * size the board stops fitting comfortably in one field of view and starts
 * demanding head turns, which costs more accuracy than the extra pixels return.
 */
const MAX_BOARD_PX = 1400

/** Non-terminal statuses worth calling out under the board. */
const CHECK_TEXT: Partial<Record<GameStatus, string>> = {
  white_check: 'White is in check',
  black_check: 'Black is in check',
}

/** How each end-of-game tone is coloured in the status strip. */
const TONE_CLASS = {
  win: 'text-emerald-300 font-semibold',
  loss: 'text-red-300 font-semibold',
  draw: 'text-amber-200 font-semibold',
} as const

/** Positions where the side to move is under check, so the king is highlighted. */
const IN_CHECK = new Set<GameStatus>(['white_check', 'black_check', 'checkmate'])

export default function Chessboard({
  gameState,
  onSquareClick,
  dwellSquare = null,
  dwellProgress = 0,
  dwellConfidence = 1,
  isThinking = false,
  focusMode = false,
  layoutKey = '',
  orientation = DEFAULT_ORIENTATION,
  zoomRegion = null,
  pendingRegion = null,
  pendingProgress = 0,
  regionDepth = 0,
}: ChessboardProps) {
  const legalMoves = useMemo(() => {
    if (!gameState.selectedSquare) return []
    return getLegalMoves(
      gameState,
      gameState.selectedSquare.row,
      gameState.selectedSquare.col,
    )
  }, [gameState])

  // The board is sized to the space that actually exists, measured, rather than
  // to an assumption about how much chrome surrounds it.
  const { ref: areaRef, size } = useMaxSquareSize(MAX_BOARD_PX, `${layoutKey}:${focusMode}`)

  // The strip says who actually won, not just that a checkmate happened — the
  // same reading the end-of-game dialog gives, so the two never disagree.
  const outcome = describeOutcome(gameState.status, gameState.whiteToMove, 'white')

  return (
    <div className="flex flex-col w-full h-full min-w-0 min-h-0">
      {/* Measured area. The board inside is taken out of flow, so it cannot
          contribute to the size of the very element being measured against it —
          otherwise the two chase each other and the board settles at whatever
          size the feedback loop happens to land on. `min-h` keeps it from
          collapsing on narrow screens, where the page scrolls and the ancestor
          heights are content-driven rather than fixed to the viewport. */}
      <div
        ref={areaRef}
        className="flex-1 relative overflow-hidden min-h-[80vw] lg:min-h-0 lg:min-w-0"
      >
        <div
          className={`absolute inset-0 flex items-center justify-center ${
            focusMode ? 'p-0' : 'p-1'
          }`}
        >
          {/* Opacity-only entrance: a `scale` here would leave the board rendered
              at <100% if the animation is ever interrupted or throttled, silently
              shrinking every square — the opposite of what we want for accuracy. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className={`overflow-hidden bg-background ${
              focusMode ? '' : 'rounded-lg border-2 shadow-2xl'
            }`}
            // Zero until the first measurement lands; rendering at a provisional
            // size first would move every square under the player's gaze.
            // The gaze pipeline anchors calibration to this box, which stays
            // put when the grid inside is magnified.
            data-chessboard-frame=""
            style={{
              width: size || undefined,
              visibility: size ? 'visible' : 'hidden',
              borderColor: focusMode ? undefined : BOARD_COLORS.edge,
              position: 'relative',
            }}
          >
            <div
              className="grid"
              // The gaze pipeline measures this element to turn a screen point
              // into a square, and needs to know which way round it is drawn.
              // When zoomed, its bounding rect grows and shifts with the
              // transform, so the existing point-to-square arithmetic keeps
              // working with no special cases — the squares scrolled out of the
              // frame simply become unreachable, which is the intent.
              data-chessboard=""
              data-orientation={orientation}
              style={{
                gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)`,
                transformOrigin: '0 0',
                transform: zoomRegion
                  ? `scale(${BOARD_SIZE / zoomRegion.size}) translate(${
                      (-zoomRegion.col * 100) / BOARD_SIZE
                    }%, ${(-zoomRegion.row * 100) / BOARD_SIZE}%)`
                  : undefined,
                transition: 'transform 220ms ease-out',
              }}
            >
              {gameState.board.map((_, visualRow) =>
                gameState.board[visualRow].map((__, visualCol) => {
                  // Cells are emitted in drawing order; each resolves to the
                  // logical square it is showing.
                  const { row: rowIndex, col: colIndex } = toLogical(
                    { row: visualRow, col: visualCol },
                    orientation,
                  )
                  const piece = gameState.board[rowIndex][colIndex]
                  const isLight = (rowIndex + colIndex) % 2 === 0
                  const isSelected =
                    gameState.selectedSquare?.row === rowIndex &&
                    gameState.selectedSquare?.col === colIndex
                  const isLastMove = !!(
                    gameState.lastMove &&
                    ((gameState.lastMove.from.row === rowIndex &&
                      gameState.lastMove.from.col === colIndex) ||
                      (gameState.lastMove.to.row === rowIndex &&
                        gameState.lastMove.to.col === colIndex))
                  )
                  const isCheckSquare =
                    gameState.status.includes('check') &&
                    piece?.type === 'K' &&
                    piece?.color === (gameState.whiteToMove ? 'white' : 'black')
                  const isLegalMove = legalMoves.some(
                    (move) => move.row === rowIndex && move.col === colIndex,
                  )
                  const isDwelling =
                    dwellSquare?.row === rowIndex && dwellSquare?.col === colIndex

                  return (
                    <Square
                      key={`${rowIndex}-${colIndex}`}
                      row={rowIndex}
                      col={colIndex}
                      piece={piece}
                      isLight={isLight}
                      isSelected={isSelected}
                      isLastMove={isLastMove}
                      isCheck={isCheckSquare}
                      isLegalMove={isLegalMove}
                      onClick={() => onSquareClick(rowIndex, colIndex)}
                      dwellProgress={isDwelling ? dwellProgress : 0}
                      dwellConfidence={dwellConfidence}
                      rankLabel={colIndex === 0 ? String(BOARD_SIZE - rowIndex) : undefined}
                      fileLabel={
                        rowIndex === BOARD_SIZE - 1 ? COLUMN_LABELS[colIndex] : undefined
                      }
                    />
                  )
                }),
              )}
              </div>

            {/*
              Coarse-region target. Drawn over the board rather than inside the
              grid so it is unaffected by the zoom transform, and kept deliberately
              loud: at this stage the player is aiming at a quarter of the board
              with an estimate that may be a couple of squares out, and they need
              to see which quarter is winning well before it commits.
            */}
            {pendingRegion && (
              <div
                className="pointer-events-none absolute z-20 rounded-lg border-4 border-[#ffd24a]"
                style={{
                  left: `${(pendingRegion.col * 100) / pendingRegion.divisions}%`,
                  top: `${(pendingRegion.row * 100) / pendingRegion.divisions}%`,
                  width: `${100 / pendingRegion.divisions}%`,
                  height: `${100 / pendingRegion.divisions}%`,
                  backgroundColor: `rgba(255, 210, 74, ${0.12 + 0.2 * pendingProgress})`,
                  boxShadow: '0 0 0 2px rgba(0,0,0,0.35) inset',
                }}
              >
                <div
                  className="absolute bottom-0 left-0 h-2 bg-[#ffd24a]"
                  style={{ width: `${pendingProgress * 100}%` }}
                />
              </div>
            )}
            </motion.div>
        </div>
      </div>

      {/* Status sits outside the measured area, so its height is subtracted from
          the board's budget automatically instead of being guessed at. */}
      <div
        className="h-6 shrink-0 flex items-center justify-center gap-2 text-sm"
        role="status"
        aria-live="polite"
      >
        {outcome ? (
          <span className={TONE_CLASS[outcome.tone]}>{outcome.headline}</span>
        ) : CHECK_TEXT[gameState.status] ? (
          <span className="text-accent font-semibold">{CHECK_TEXT[gameState.status]}</span>
        ) : isThinking ? (
          <span className="text-primary font-semibold animate-pulse">
            Stockfish is thinking…
          </span>
        ) : (
          <span className="text-muted-foreground">
            {gameState.whiteToMove ? 'White' : 'Black'} to move
          </span>
        )}
      </div>
    </div>
  )
}
