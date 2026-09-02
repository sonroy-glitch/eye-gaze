/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012) for the gaze cursor.
 *
 * The previous filter was a fixed-alpha EMA, which forces a single compromise on
 * a signal that has two completely different regimes:
 *
 *   - during a *fixation* the eye is essentially still and everything moving the
 *     estimate is noise, so you want heavy smoothing;
 *   - during a *saccade* the eye jumps a whole board in ~40ms, and smoothing is
 *     pure lag — the cursor crawls toward the square the user is already looking
 *     at, and the dwell timer starts late or on the wrong square.
 *
 * A fixed alpha has to be wrong in one regime to be right in the other; at the
 * default smoothing of 0.7 ours sat at alpha 0.27, i.e. a ~110ms time constant
 * applied equally to both. The One Euro filter instead varies its cutoff with
 * the observed speed: near-still input is cut hard, fast input is passed almost
 * untouched. That is exactly the fixation/saccade split, and it is why this
 * filter is the standard choice for interactive pointing signals.
 *
 * It is also timestamp-driven rather than frame-driven, which matters here: the
 * tracker's frame rate swings with CPU load, and a per-frame alpha silently
 * changes its own time constant when the rate drops.
 */

export interface OneEuroOptions {
  /**
   * Cutoff (Hz) applied when the signal is stationary. Lower = steadier and
   * laggier. This is the knob the user's "smoothing" setting drives.
   */
  minCutoff: number
  /**
   * How aggressively the cutoff opens up with speed (Hz per px/s). This is what
   * removes lag from saccades; too high and jitter returns during fast motion.
   */
  beta: number
  /** Cutoff (Hz) of the derivative estimate itself. */
  dCutoff: number
}

export const DEFAULT_ONE_EURO_OPTIONS: OneEuroOptions = {
  minCutoff: 1,
  // Gaze speeds here are in viewport px/s: a saccade across the board is on the
  // order of 1500px/s, so 0.004 lifts the cutoff by ~6Hz mid-saccade (motion
  // passes through almost unfiltered) while a 20px/s fixation tremor barely
  // moves it off minCutoff at all.
  beta: 0.004,
  dCutoff: 1,
}

function alphaFor(cutoff: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dtSeconds)
}

class ScalarOneEuro {
  private value: number | null = null
  private derivative = 0

  reset(): void {
    this.value = null
    this.derivative = 0
  }

  filter(x: number, dtSeconds: number, options: OneEuroOptions): number {
    if (this.value === null) {
      this.value = x
      this.derivative = 0
      return x
    }

    const rawDerivative = (x - this.value) / dtSeconds
    const dAlpha = alphaFor(options.dCutoff, dtSeconds)
    this.derivative = this.derivative + dAlpha * (rawDerivative - this.derivative)

    const cutoff = options.minCutoff + options.beta * Math.abs(this.derivative)
    const alpha = alphaFor(cutoff, dtSeconds)
    this.value = this.value + alpha * (x - this.value)
    return this.value
  }
}

export class OneEuroFilter2D {
  private readonly fx = new ScalarOneEuro()
  private readonly fy = new ScalarOneEuro()
  private lastTimestamp: number | null = null
  private options: OneEuroOptions

  constructor(options: Partial<OneEuroOptions> = {}) {
    this.options = { ...DEFAULT_ONE_EURO_OPTIONS, ...options }
  }

  configure(options: Partial<OneEuroOptions>): void {
    this.options = { ...this.options, ...options }
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
    this.lastTimestamp = null
  }

  /** `timestampMs` should be a monotonic clock — `performance.now()`. */
  filter(x: number, y: number, timestampMs: number): { x: number; y: number } {
    // Clamped so a stalled tab (dt of seconds) or a duplicated timestamp cannot
    // drive alpha to either extreme and either freeze or unsmooth the cursor.
    const dt =
      this.lastTimestamp === null
        ? 1 / 30
        : Math.min(0.25, Math.max(1 / 120, (timestampMs - this.lastTimestamp) / 1000))
    this.lastTimestamp = timestampMs

    return {
      x: this.fx.filter(x, dt, this.options),
      y: this.fy.filter(y, dt, this.options),
    }
  }
}

/**
 * Map the user-facing 0..1 "smoothing" slider onto a stationary cutoff.
 *
 * 0 -> 2.5Hz (responsive, visibly jittery), 1 -> 0.35Hz (very steady, ~450ms to
 * settle). The default 0.7 lands near 0.9Hz. The curve is exponential because
 * cutoff is a frequency: equal slider steps should feel like equal steps.
 */
export function smoothingToMinCutoff(strength: number): number {
  const s = Math.max(0, Math.min(1, strength))
  return 2.5 * Math.pow(0.35 / 2.5, s)
}
