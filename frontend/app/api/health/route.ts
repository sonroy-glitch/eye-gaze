import { NextResponse } from 'next/server'
import { checkDatabase } from '@/lib/server/prisma'
import { analyze } from '@/lib/server/stockfish'

/**
 * GET /api/health — is this deployment actually able to serve the auth routes?
 *
 * Signup and signin fail closed on three things the deploy has to get right: a
 * database URL, a reachable and migrated database, and a session secret long
 * enough to sign a token with. When one is missing they can only answer with a
 * generic error (anything more would leak configuration to the internet), so
 * this reports each one as a plain boolean — never a value, a connection string,
 * or a database message.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Matches the floor enforced in lib/server/session.ts. */
const MIN_SECRET_BYTES = 32

/**
 * Can this deployment actually produce a move?
 *
 * The engine is the one dependency whose absence is invisible from the UI: the
 * game simply stops answering the player's eyes, because a turn that never
 * completes leaves gaze control disabled. Worth being able to check without
 * playing a game. Uses the opening position at minimum depth so it stays cheap.
 */
async function checkEngine(): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now()
  try {
    const result = await analyze(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      1,
      1,
    )
    return { ok: !!result.bestmove, ms: Date.now() - started }
  } catch {
    return { ok: false, ms: Date.now() - started }
  }
}

export async function GET() {
  const secret = process.env.AUTH_SECRET
  const authSecretOk = !!secret && new TextEncoder().encode(secret).length >= MIN_SECRET_BYTES

  const databaseUrlSet = !!process.env.DATABASE_URL
  const database = databaseUrlSet ? await checkDatabase() : { ok: false, code: 'no_database_url' }
  const engine = await checkEngine()

  const ok = authSecretOk && database.ok && engine.ok

  return NextResponse.json(
    {
      msg: ok ? 'Server is working' : 'Server is misconfigured',
      ok,
      checks: {
        authSecretSet: !!secret,
        // The single most common cause of a 500 from signin/signup: a secret
        // that exists but is under 32 bytes, which cannot key HS256 at all.
        authSecretLongEnough: authSecretOk,
        databaseUrlSet,
        // False with code P2021 means the database is up but the User table was
        // never created — `npm run db:migrate` against the production database.
        databaseReachable: database.ok,
        ...(database.ok ? {} : { databaseErrorCode: database.code }),
        // False here means every game will be played by the weak local
        // fallback. The game stays playable, but it is not Stockfish.
        chessEngineWorking: engine.ok,
        chessEngineMs: engine.ms,
      },
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
