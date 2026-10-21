import type { NextConfig } from 'next'

/**
 * The `stockfish` package must not be bundled.
 *
 * Its entry point locates the engine with dynamic requires built from
 * `__dirname` (`/bin/stockfish.js`, `/src/stockfish.js`). A bundler cannot
 * resolve a path it only learns at runtime, so Turbopack fails the build with
 * nine `module-not-found` errors and the deploy never ships. Marking it
 * external leaves it as a plain runtime `require` out of `node_modules`, which
 * is how an emscripten module expects to be loaded.
 *
 * This is also why a cached local build could pass while a clean one failed:
 * the resolution was being served from a warm module graph. `rm -rf .next`
 * reproduces what the deploy actually does.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['stockfish'],
}

export default nextConfig
