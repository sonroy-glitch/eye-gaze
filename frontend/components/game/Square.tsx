'use client'

import { motion } from 'framer-motion'
import { Piece } from '@/lib/chess/types'
import { BOARD_COLORS } from '@/lib/chess/constants'
import ChessPiece from './ChessPiece'

interface SquareProps {
  row: number
  col: number
  piece: Piece | null
  isLight: boolean
  isSelected: boolean
  isLastMove: boolean
  isCheck: boolean
  isLegalMove: boolean
  /**
   * Holds one of the player's own pieces while nothing is picked yet, so it is
   * a square worth aiming at. Only black pieces and empty squares are left
   * unmarked, which is the point: a three-look descent onto one of those is
   * three looks wasted, and the player should be able to see that before they
   * start rather than after.
   */
  isSelectable?: boolean
  onClick: () => void
  /** 0..1 gaze-dwell progress toward activating this square, if any. */
  dwellProgress?: number
  /** 0..1 confidence in that square, which fades the ring when it is weak. */
  dwellConfidence?: number
  /** File letter, drawn in-square on the bottom rank only. */
  fileLabel?: string
  /** Rank number, drawn in-square on the a-file only. */
  rankLabel?: string
}

export default function Square({
  row,
  col,
  piece,
  isLight,
  isSelected,
  isLastMove,
  isCheck,
  isLegalMove,
  isSelectable = false,
  onClick,
  dwellProgress = 0,
  dwellConfidence = 1,
  fileLabel,
  rankLabel,
}: SquareProps) {
  // Square colours come from the board palette rather than the app's theme
  // tokens: the board wants its own green/black identity, and it must not drift
  // when the surrounding UI's greys are retuned.
  const background = isLight ? BOARD_COLORS.light : BOARD_COLORS.dark
  const labelColor = isLight ? BOARD_COLORS.labelOnLight : BOARD_COLORS.labelOnDark

  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      data-square={`${row}-${col}`}
      style={{ containerType: 'size', backgroundColor: background }}
      className={`
        relative w-full aspect-square flex items-center justify-center
        transition-all duration-200
        border border-transparent
        ${isSelected ? 'border-2 border-primary ring-2 ring-primary/60 ring-inset' : ''}
        ${isLegalMove ? 'ring-2 ring-primary/40 ring-inset' : ''}
        ${isSelectable ? 'ring-2 ring-[#7fd4ff]/55 ring-inset' : ''}
        cursor-pointer group
      `}
    >
      {/* Square washes are painted as overlays instead of swapping the base
          colour, so "last move" and "in check" look the same on a light square
          as on a dark one. */}
      {isLastMove && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: BOARD_COLORS.lastMove }}
        />
      )}
      {isCheck && (
        <div
          className="absolute inset-0 pointer-events-none ring-2 ring-inset ring-red-500"
          style={{ backgroundColor: BOARD_COLORS.check }}
        />
      )}
      <div className="absolute inset-0 pointer-events-none bg-white/0 group-hover:bg-white/10 transition-colors" />

      {/* Coordinates are drawn inside the edge squares rather than in gutters
          around the board. The gutters cost ~36px of layout in both axes, and on
          a height-constrained screen that is the difference between the board
          fitting at one square size and the next one down. */}
      {rankLabel && (
        <span
          aria-hidden
          className="absolute left-[4cqmin] top-[2cqmin] font-bold select-none pointer-events-none"
          style={{ fontSize: '13cqmin', lineHeight: 1, color: labelColor }}
        >
          {rankLabel}
        </span>
      )}
      {fileLabel && (
        <span
          aria-hidden
          className="absolute right-[4cqmin] bottom-[2cqmin] font-bold select-none pointer-events-none uppercase"
          style={{ fontSize: '13cqmin', lineHeight: 1, color: labelColor }}
        >
          {fileLabel}
        </span>
      )}

      {/* Gaze dwell progress ring. Its opacity tracks confidence, so a square
          the tracker is only half-sure about looks half-sure rather than
          identical to a certain one. */}
      {dwellProgress > 0 && (
        <div
          className="absolute inset-0 pointer-events-none rounded-sm"
          style={{
            background: `conic-gradient(rgba(168,85,247,${0.25 + 0.5 * Math.max(0, Math.min(1, dwellConfidence))}) ${dwellProgress * 360}deg, transparent 0deg)`,
            WebkitMaskImage: 'radial-gradient(circle, transparent 62%, black 64%)',
            maskImage: 'radial-gradient(circle, transparent 62%, black 64%)',
          }}
        />
      )}

      {/* Legal move indicator */}
      {isLegalMove && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className={
            piece
              ? 'absolute inset-[8cqmin] rounded-full border-[4cqmin] border-primary/55 pointer-events-none'
              : 'absolute w-[26cqmin] h-[26cqmin] rounded-full bg-primary/60 pointer-events-none'
          }
        />
      )}

      {/* Piece. Each side is a filled silhouette outlined in the opposite
          colour, so shape carries the identity and colour carries the side. */}
      {piece && (
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            type: 'spring',
            stiffness: 260,
            damping: 20,
          }}
          className="relative w-[84cqmin] h-[84cqmin] select-none pointer-events-none"
        >
          <ChessPiece type={piece.type} color={piece.color} className="w-full h-full" />
        </motion.div>
      )}
    </motion.button>
  )
}
