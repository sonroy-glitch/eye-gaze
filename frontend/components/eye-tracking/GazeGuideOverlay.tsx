'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, Lightbulb, MousePointerClick, Move, RefreshCw, Target, Timer, Zap } from 'lucide-react'
import {
  ADAPTATION_TARGETS,
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS_ON_BOARD,
} from '@/lib/eye-tracking/calibration-model'

export type GazeGuideVariant = 'before-calibration' | 'how-to-play'
export type GazeGuideReason = 'first-time' | 'struggling' | 'manual'

interface GazeGuideOverlayProps {
  open: boolean
  variant: GazeGuideVariant
  /** Why we are showing it — only changes the framing line and the CTA wording. */
  reason?: GazeGuideReason
  /** Primary action: start calibration / start playing. */
  onContinue: () => void
  /** Secondary action, offered when the user is stuck: redo the calibration. */
  onRecalibrate?: () => void
  /** Back out entirely (leaves eye control). */
  onCancel?: () => void
  /** Estimated seconds the calibration will take, shown before it starts. */
  estimatedSeconds?: number
}

const TOTAL_DOTS =
  ADAPTATION_TARGETS.length + CALIBRATION_TARGETS.length + VALIDATION_TARGETS_ON_BOARD.length

/**
 * The instructions the client asked for, in the two places they asked for them:
 * once *before* the dots appear, and once *after* calibration succeeds, before
 * the first move. It is also re-shown when a player is visibly struggling to
 * land a move (see `struggle` handling on the game page).
 *
 * Deliberately loud. This is the screen a first-time user reads at arm's length
 * from a laptop, often with a visual impairment, so it ignores the app's muted
 * palette: near-black ground, amber-on-white headings, and body text at 18-20px
 * rather than the 12-14px used elsewhere in the UI.
 */
export default function GazeGuideOverlay({
  open,
  variant,
  reason = 'first-time',
  onContinue,
  onRecalibrate,
  onCancel,
  estimatedSeconds = 17,
}: GazeGuideOverlayProps) {
  const continueRef = useRef<HTMLButtonElement | null>(null)

  // Enter/Space runs the primary action, Esc backs out. A gaze user cannot yet
  // point at a button at this stage (that is the whole point of the screen), so
  // every action here has to be reachable from the keyboard.
  useEffect(() => {
    if (!open) return
    continueRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onContinue()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onContinue, onCancel])

  const steps = variant === 'before-calibration' ? SETUP_STEPS : PLAY_STEPS

  const heading =
    variant === 'before-calibration'
      ? 'Before we calibrate your eyes'
      : reason === 'struggling'
        ? 'Having trouble? Here it is again'
        : 'Your eyes are calibrated — here is how to play'

  const subheading =
    variant === 'before-calibration'
      ? `${TOTAL_DOTS} dots, about ${estimatedSeconds} seconds. Read these four things first — they are the difference between calibration working first time and having to redo it.`
      : reason === 'struggling'
        ? 'Nothing has moved for a while, so here are the three steps again. If the board still will not follow your eyes, recalibrate.'
        : 'Three steps. You can always fall back to the mouse — it keeps working.'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={heading}
        >
          <div className="absolute inset-0 bg-[#05070a]/95 backdrop-blur-sm" />

          <motion.div
            initial={{ scale: 0.96, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="relative w-[min(94vw,44rem)] max-h-[92vh] overflow-y-auto rounded-2xl border-2 border-[#ffd24a] bg-[#0d1117] p-6 sm:p-8 shadow-[0_0_60px_rgba(255,210,74,0.25)]"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#ffd24a] text-[#0d1117]">
                {variant === 'before-calibration' ? (
                  <Target className="h-7 w-7" />
                ) : (
                  <Eye className="h-7 w-7" />
                )}
              </span>
              <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                {heading}
              </h2>
            </div>

            <p className="mt-4 text-lg leading-relaxed text-[#e8eef7]">{subheading}</p>

            <ol className="mt-6 space-y-4">
              {steps.map((step, i) => (
                <li key={step.title} className="flex gap-4">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 border-[#7fd4ff] text-[#7fd4ff]">
                    <step.icon className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-lg font-bold text-white">
                      {i + 1}. {step.title}
                    </p>
                    <p className="text-base leading-relaxed text-[#c3cede]">{step.copy}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <button
                ref={continueRef}
                type="button"
                onClick={onContinue}
                className="flex-1 rounded-xl bg-[#ffd24a] px-6 py-4 text-lg font-extrabold text-[#0d1117] outline-none transition-transform hover:scale-[1.02] focus-visible:ring-4 focus-visible:ring-white"
              >
                {variant === 'before-calibration'
                  ? "I'm ready — start calibration"
                  : 'Got it — start playing'}
              </button>
              {variant === 'how-to-play' && onRecalibrate && (
                <button
                  type="button"
                  onClick={onRecalibrate}
                  className="rounded-xl border-2 border-[#7fd4ff] px-6 py-4 text-lg font-bold text-[#7fd4ff] outline-none transition-colors hover:bg-[#7fd4ff]/10 focus-visible:ring-4 focus-visible:ring-white"
                >
                  Recalibrate (C)
                </button>
              )}
            </div>

            <p className="mt-4 text-center text-base text-[#9fb0c6]">
              Press <Kbd>Enter</Kbd> to continue
              {onCancel ? (
                <>
                  {' '}
                  or <Kbd>Esc</Kbd> to leave eye control
                </>
              ) : null}
              . Your camera never leaves this device.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const SETUP_STEPS = [
  {
    icon: Move,
    title: 'Sit an arm’s length away, facing the camera',
    copy: 'Centre your face in the small camera preview at the bottom-left. Both eyes need to be in frame the whole time.',
  },
  {
    icon: Lightbulb,
    title: 'Put the light on your face, not behind you',
    copy: 'A window or lamp in front of you is ideal. A bright window behind you turns your face into a silhouette and calibration will fail.',
  },
  {
    icon: Timer,
    title: 'Keep your head still — move only your eyes',
    copy: 'The tracker learns where your eyes point from this one head position. If you shift or lean afterwards, press C to redo it.',
  },
  {
    icon: MousePointerClick,
    title: 'Look straight at each dot until it moves on',
    copy: 'Each dot captures on its own in about a second — just hold your gaze on it. The first five teach the tracker your eyes; the rest line it up with the board.',
  },
]

const PLAY_STEPS = [
  {
    icon: Eye,
    title: 'Look at the piece you want to move, and hold',
    copy: 'A ring fills around the square as you hold it. When the ring completes, the piece is selected and its legal moves light up.',
  },
  {
    icon: Target,
    title: 'Look at the square you want to move to, and hold',
    copy: 'Same again — hold your gaze until that square is the one highlighted. Looking back at the selected piece deselects it.',
  },
  {
    icon: Zap,
    title: 'Blink deliberately to confirm the move',
    copy: 'A long, firm blink (about half a second) commits it. Ordinary quick blinks are ignored, so nothing moves by accident.',
  },
  {
    icon: RefreshCw,
    title: 'If the board is not following your eyes',
    copy: 'Press C to recalibrate, H to bring these instructions back, or just use the mouse — clicking squares still works and quietly teaches the tracker as you go.',
  },
]

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-1 rounded border border-[#9fb0c6]/60 bg-white/10 px-1.5 py-0.5 font-mono text-sm text-white">
      {children}
    </kbd>
  )
}
