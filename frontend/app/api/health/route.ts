import { NextResponse } from 'next/server'
import { checkDatabase } from '@/lib/server/prisma'

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

/*
 * Deliberately does NOT check the chess engine.
 *
 * Importing `lib/server/stockfish` here pulled the emscripten WASM module into
 * this route's bundle, and its dynamic requires fail to resolve at build time,
 * which broke the deploy outright. The engine has its own endpoint and is far
 * better checked by asking it for a move:
 *
 *   curl -X POST https://HOST/api/ai-move \
 *     -H 'Content-Type: application/json' \
 *     -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
 *
 * A 200 with a `bestmove` means the engine is alive on that deployment.
 */
export async function GET() {
  const secret = process.env.AUTH_SECRET
  const authSecretOk = !!secret && new TextEncoder().encode(secret).length >= MIN_SECRET_BYTES

  const databaseUrlSet = !!process.env.DATABASE_URL
  const database = databaseUrlSet ? await checkDatabase() : { ok: false, code: 'no_database_url' }

  const ok = authSecretOk && database.ok

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
      },
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
