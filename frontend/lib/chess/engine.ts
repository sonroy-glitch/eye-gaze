import { Chess, type Square as AlgebraicSquare } from 'chess.js'
import {
  type BoardPosition,
  type GameState,
  type GameStatus,
  type Move,
  type Piece,
  type PieceType,
  type SquareContent,
} from './types'

/**
 * Chess rules, delegated to chess.js.
 *
 * This used to be a hand-written move generator, and it was wrong in the ways
 * hand-written move generators usually are: no castling, no en passant, and —
 * worst of the three — no check filtering, so a piece could be moved out of a
 * pin and leave its own king captured. It also never detected checkmate,
 * stalemate, repetition or the fifty-move rule locally, and inferred castling
 * rights by looking at where pieces were standing, which cannot distinguish
 * "never moved" from "moved away and came back".
 *
 * chess.js is the library lichess-adjacent projects use for exactly this, and
 * the app's own representation is kept unchanged around it: `GameState.fen` is
 * the source of truth, and the board grid the UI renders is derived from it.
 */

const FILES = 'abcdefgh'

/** Grid position to algebraic square, e.g. {row:6,col:4} -> "e2". */
export function toAlgebraic(pos: BoardPosition): AlgebraicSquare {
  return `${FILES[pos.col]}${8 - pos.row}` as AlgebraicSquare
}

/** Algebraic square to grid position, e.g. "e2" -> {row:6,col:4}. */
export function toPosition(square: string): BoardPosition {
  return { row: 8 - Number(square[1]), col: FILES.indexOf(square[0]) }
}

/**
 * chess.js reports rank 8 first and lowercases black, which is precisely the
 * grid convention the UI already uses — so this is a straight relabelling.
 */
function boardFrom(chess: Chess): SquareContent[][] {
  return chess.board().map((rank) =>
    rank.map<SquareContent>((cell) =>
      cell
        ? {
            type: cell.type.toUpperCase() as PieceType,
            color: cell.color === 'w' ? 'white' : 'black',
          }
        : null,
    ),
  )
}

/**
 * Terminal conditions are checked before `isDraw()`, which is true for all of
 * them — asking it first would report every stalemate and repetition as a
 * generic fifty-move draw.
 */
function statusFrom(chess: Chess): GameStatus {
  if (chess.isCheckmate()) return 'checkmate'
  if (chess.isStalemate()) return 'stalemate'
  if (chess.isInsufficientMaterial()) return 'draw_insufficient'
  if (chess.isThreefoldRepetition()) return 'draw_repetition'
  if (chess.isDraw()) return 'draw_fifty_move'
  if (chess.isCheck()) return chess.turn() === 'w' ? 'white_check' : 'black_check'
  return 'playing'
}

/** Load a position, returning null rather than throwing on a malformed FEN. */
function load(fen: string): Chess | null {
  try {
    return new Chess(fen)
  } catch {
    return null
  }
}

export function createGame(): GameState {
  const chess = new Chess()
  return {
    fen: chess.fen(),
    board: boardFrom(chess),
    whiteToMove: true,
    moves: [],
    status: 'playing',
    selectedSquare: null,
    lastMove: null,
    capturedPieces: { white: [], black: [] },
  }
}

export function isValidPosition(row: number, col: number): boolean {
  return row >= 0 && row <= 7 && col >= 0 && col <= 7
}

export function getPieceAt(
  board: SquareContent[][],
  row: number,
  col: number,
): Piece | null {
  if (!isValidPosition(row, col)) return null
  return board[row][col] ?? null
}

export function isSameColor(a: Piece | null, b: Piece | null): boolean {
  if (!a || !b) return false
  return a.color === b.color
}

/**
 * Legal destinations for the piece on a square — fully legal, so moves that
 * would leave the mover's own king in check are already excluded, and castling
 * and en passant are included.
 *
 * This takes the whole game state rather than just the board grid, because
 * legality genuinely depends on more than piece placement: castling needs the
 * rights, en passant needs the target square. That was the flaw in the previous
 * signature, not an inconvenience of this one.
 */
export function getLegalMoves(
  gameState: GameState,
  row: number,
  col: number,
): BoardPosition[] {
  const chess = load(gameState.fen)
  if (!chess) return []

  const moves = chess.moves({ square: toAlgebraic({ row, col }), verbose: true })

  // A pawn reaching the last rank yields one move per promotion piece, all to
  // the same square; the board only wants the square once.
  const seen = new Set<string>()
  const destinations: BoardPosition[] = []
  for (const move of moves) {
    if (seen.has(move.to)) continue
    seen.add(move.to)
    destinations.push(toPosition(move.to))
  }
  return destinations
}

export function isLegalMove(
  gameState: GameState,
  from: BoardPosition,
  to: BoardPosition,
): boolean {
  return getLegalMoves(gameState, from.row, from.col).some(
    (m) => m.row === to.row && m.col === to.col,
  )
}

/** Rough piece values, only good enough to prefer the better capture. */
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/**
 * A legal reply computed in the browser, for when the Stockfish endpoint cannot
 * be reached.
 *
 * This exists because the alternative is a dead game. The engine runs in a route
 * handler, and a single failed call used to leave the position on the opponent's
 * turn forever: no retry, no message, and `isHumanTurn` false, which disables
 * the gaze dwell entirely. The board stops answering the player's eyes even
 * though the tracker is working perfectly, which is the single worst failure
 * this app has, and it is invisible from the outside.
 *
 * It is deliberately weak and deliberately not a substitute for Stockfish. It
 * prefers the most valuable capture and otherwise moves at random, which keeps a
 * game going until the endpoint recovers.
 */
export function pickFallbackMove(gameState: GameState): string | null {
  const chess = load(gameState.fen)
  if (!chess) return null

  const moves = chess.moves({ verbose: true })
  if (!moves.length) return null

  let best = moves[0]
  let bestScore = -1
  for (const move of moves) {
    const score = move.captured ? (PIECE_VALUE[move.captured] ?? 0) : 0
    // Random tiebreak so a fallback game is not the same game every time.
    const jittered = score + Math.random() * 0.5
    if (jittered > bestScore) {
      bestScore = jittered
      best = move
    }
  }
  return `${best.from}${best.to}${best.promotion ?? ''}`
}

/**
 * Build the next state from a position that has just had a move applied.
 * `applied` is the chess.js move record for that move.
 */
export function advance(
  previous: GameState,
  chess: Chess,
  applied: { from: string; to: string; san: string; captured?: string; color: string },
): GameState {
  const move: Move = {
    from: toPosition(applied.from),
    to: toPosition(applied.to),
    notation: applied.san,
    timestamp: Date.now(),
  }

  const capturedPieces = {
    white: [...previous.capturedPieces.white],
    black: [...previous.capturedPieces.black],
  }
  if (applied.captured) {
    // The captured piece belongs to whoever did not make the move.
    const owner = applied.color === 'w' ? 'black' : 'white'
    capturedPieces[owner].push(applied.captured.toUpperCase() as PieceType)
  }

  return {
    fen: chess.fen(),
    board: boardFrom(chess),
    whiteToMove: chess.turn() === 'w',
    moves: [...previous.moves, move],
    status: statusFrom(chess),
    selectedSquare: null,
    lastMove: move,
    capturedPieces,
  }
}

/**
 * Play a move. Returns null if it is illegal, so the caller can simply ignore
 * it — a gaze mis-selection lands here constantly and must never corrupt the
 * position.
 *
 * Promotion is taken automatically as a queen. Underpromotion is legal but
 * vanishingly rare, and offering the choice would mean a four-way picker driven
 * by dwell in the middle of a move.
 */
export function makeMove(
  gameState: GameState,
  from: BoardPosition,
  to: BoardPosition,
  promotion: 'q' | 'r' | 'b' | 'n' = 'q',
): GameState | null {
  const chess = load(gameState.fen)
  if (!chess) return null

  try {
    const applied = chess.move({
      from: toAlgebraic(from),
      to: toAlgebraic(to),
      promotion,
    })
    if (!applied) return null
    return advance(gameState, chess, applied)
  } catch {
    // chess.js throws on an illegal move; that is an expected outcome here.
    return null
  }
}

/** Re-export so callers have one place to import rule logic from. */
export { statusFrom as deriveStatus, boardFrom as deriveBoard }
