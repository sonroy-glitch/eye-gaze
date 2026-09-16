import type { GameStatus, PieceColor } from './types'

export type OutcomeTone = 'win' | 'loss' | 'draw'

export interface GameOutcome {
  /** Big line, e.g. "You Won the Game!" or "Checkmate!". */
  headline: string
  /** One sentence explaining how the game ended. */
  detail: string
  tone: OutcomeTone
}

/**
 * Turn a finished game's status into what the player should be told.
 *
 * `whiteToMove` is what makes this readable at all: chess.js reports checkmate
 * and stalemate against the side *to move*, so the side that is mated is the
 * one whose turn it is — the loser, never the winner. Reading the status alone
 * cannot tell a win from a loss, which is why the board used to say a flat
 * "Checkmate" either way.
 *
 * Returns null while the game is still live (including plain check).
 */
export function describeOutcome(
  status: GameStatus,
  whiteToMove: boolean,
  humanColor: PieceColor = 'white',
): GameOutcome | null {
  const sideToMove: PieceColor = whiteToMove ? 'white' : 'black'

  switch (status) {
    case 'checkmate': {
      const humanLost = sideToMove === humanColor
      return humanLost
        ? {
            headline: 'Checkmate!',
            detail: 'Your king has no legal move left. Stockfish wins this one.',
            tone: 'loss',
          }
        : {
            headline: 'You won the game!',
            detail: 'Stockfish has no legal move left.',
            tone: 'win',
          }
    }
    case 'stalemate':
      return {
        headline: 'Stalemate',
        detail: `${sideToMove === 'white' ? 'White' : 'Black'} has no legal move but is not in check. The game is a draw.`,
        tone: 'draw',
      }
    case 'draw_repetition':
      return {
        headline: 'Draw',
        detail: 'The same position has appeared three times.',
        tone: 'draw',
      }
    case 'draw_fifty_move':
      return {
        headline: 'Draw',
        detail: 'Fifty moves have passed with no capture and no pawn move.',
        tone: 'draw',
      }
    case 'draw_insufficient':
      return {
        headline: 'Draw',
        detail: 'Neither side has enough material to deliver checkmate.',
        tone: 'draw',
      }
    default:
      return null
  }
}
