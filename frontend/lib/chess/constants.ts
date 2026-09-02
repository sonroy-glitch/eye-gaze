export const BOARD_SIZE = 8
export const SQUARE_SIZE_PX = 88

export const COLUMN_LABELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
export const ROW_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const

export const INITIAL_BOARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'

/**
 * Board palette. Each entry resolves a CSS custom property defined in
 * `globals.css`, so the accessibility menu's high-contrast mode repaints the
 * board along with the rest of the UI just by putting a class on <html> — the
 * squares are inline-styled and would otherwise stay green while everything
 * around them went black and yellow.
 *
 * The fallbacks after each `var()` keep the board drawable if these are ever
 * rendered outside the app stylesheet (docs, tests, a stray Storybook).
 */
export const BOARD_COLORS = {
  light: 'var(--board-light, #7fae86)',
  dark: 'var(--board-dark, #24322b)',
  /** Ring/edge tint used for the frame around the board. */
  edge: 'var(--board-edge, #3d5747)',
  /** Wash laid over the from/to squares of the last move. */
  lastMove: 'var(--board-last-move, rgba(255, 224, 102, 0.45))',
  /** Wash over the king's square while it is in check. */
  check: 'var(--board-check, rgba(235, 80, 65, 0.6))',
  /** In-square coordinate labels, drawn in the *other* square colour. */
  labelOnLight: 'var(--board-label-on-light, rgba(21, 30, 25, 0.85))',
  labelOnDark: 'var(--board-label-on-dark, rgba(150, 199, 158, 0.95))',
} as const
