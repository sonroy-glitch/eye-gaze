'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { Eye, ArrowLeft, Lightbulb, Maximize2, MousePointerClick, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Calibration moved into the game itself.
 *
 * The tracker is now WebEyeTrack, which personalises its gaze model from
 * look-aligned clicks and adapts on-device inside a Web Worker. That adaptation
 * does not survive a page navigation, so it can no longer live on a separate
 * route — it is collected in the same session it is used. Entering eye control on
 * the game page (fullscreen) runs a quick click-the-dots calibration, and every
 * board click you make afterwards keeps refining it.
 *
 * This page is kept only so existing links land somewhere sensible and explain
 * the new flow.
 */
export default function CalibrationInfoPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Link href="/game" className="fixed top-4 left-4 z-30">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
          Back to Game
        </motion.button>
      </Link>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="max-w-lg w-full space-y-6 text-center"
      >
        <div className="flex justify-center">
          <Eye className="w-16 h-16 text-primary" />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Calibration is now in the game</h1>
          <p className="text-lg text-foreground/90">
            Eye tracking is set up inside the game — no separate step. It takes about seventeen
            seconds: a short instructions card, eighteen dots, and you are playing.
          </p>
        </div>

        <div className="space-y-3 text-left rounded-xl border border-border bg-card/60 p-5">
          <Step icon={<Maximize2 className="w-5 h-5 text-primary" />} title="Enter eye control">
            On the game page press{' '}
            <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono">F</kbd> or
            the fullscreen button. The board fills the screen so squares are large enough to pick by
            eye.
          </Step>
          <Step icon={<Lightbulb className="w-5 h-5 text-primary" />} title="Get the light and your seat right first">
            Light on your face, not behind you. Sit about an arm's length from the screen, centred
            on the camera, and keep your head still — the game shows you this checklist before the
            dots start.
          </Step>
          <Step icon={<MousePointerClick className="w-5 h-5 text-primary" />} title="Look at the dots">
            Eighteen dots appear over the board, roughly a second each. The first five teach the
            tracker itself where your eyes point; the rest fit the board to them. Look straight at
            each one and hold until it moves on.
          </Step>
          <Step icon={<Sparkles className="w-5 h-5 text-primary" />} title="Then it explains how to play">
            When calibration finishes you get the three steps — look to select, look to target,
            blink to confirm — and they come back automatically if a move will not land. Press{' '}
            <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono">H</kbd> for
            them any time, or{' '}
            <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono">C</kbd> to
            recalibrate.
          </Step>
        </div>

        <Link href="/game">
          <Button size="lg" className="w-full bg-primary hover:bg-accent">
            Go to the game
          </Button>
        </Link>
        <p className="text-sm text-muted-foreground">Your camera turns on only in eye control. Video never leaves this device.</p>
      </motion.div>
    </div>
  )
}

function Step({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}
