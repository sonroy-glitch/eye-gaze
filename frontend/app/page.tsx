'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Accessibility,
  Brain,
  Camera,
  Crosshair,
  Eye,
  Gauge,
  Globe,
  Heart,
  Info,
  Keyboard,
  Lightbulb,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import LandingNav from '@/components/landing/LandingNav'
import MiniBoard from '@/components/landing/MiniBoard'
import FaceMesh from '@/components/landing/FaceMesh'

/** The three promises that sit directly under the hero buttons. */
const HERO_POINTS = [
  { icon: Camera, title: 'No Special Hardware', copy: 'Works with any webcam' },
  { icon: SlidersHorizontal, title: 'Adaptive AI', copy: 'Difficulty adjusts to you' },
  { icon: ShieldCheck, title: 'Accessible by Design', copy: 'Built for everyone' },
]

const STEPS = [
  {
    icon: Camera,
    title: '1. Calibrate',
    copy: 'Eighteen dots, about seventeen seconds. Look at each one; the game learns where your eyes point.',
  },
  { icon: Eye, title: '2. Look', copy: 'Hold your gaze on a piece for about a second to select it.' },
  { icon: Crosshair, title: '3. Gaze', copy: 'Hold your gaze on the square you want to move to.' },
  { icon: Zap, title: '4. Blink', copy: 'One deliberate, half-second blink confirms the move.' },
]

/**
 * The set-up checklist the client asked for: it has to be readable *before*
 * anyone opens the game, because every item on it is something you cannot fix
 * once calibration has already started.
 */
const BEFORE_YOU_START = [
  {
    icon: Camera,
    title: 'Allow the camera when the browser asks',
    copy: 'Video is processed on your own device and never uploaded. Nothing turns on until you enter eye control.',
  },
  {
    icon: Lightbulb,
    title: 'Light your face from the front',
    copy: 'A window or lamp facing you. A bright window behind you makes your face a silhouette, and tracking will not work.',
  },
  {
    icon: Gauge,
    title: 'Sit an arm’s length away and stay put',
    copy: 'Centre yourself on the camera. Calibration learns one head position — if you shift, press C to redo it.',
  },
  {
    icon: Keyboard,
    title: 'Learn three keys',
    copy: 'F enters full-screen eye control, C recalibrates, Esc leaves. The mouse keeps working the whole time.',
  },
]

const FEATURES = [
  {
    icon: Eye,
    title: 'Eye Tracking',
    copy: 'A webcam and an on-device model turn where you look into the square you mean.',
  },
  {
    icon: Zap,
    title: 'Blink Confirmation',
    copy: 'Nothing moves until you say so — a deliberate blink commits the move.',
  },
  {
    icon: Brain,
    title: 'Adaptive AI',
    copy: 'Stockfish on the back end, with difficulty that meets you where you are.',
  },
  {
    icon: Globe,
    title: 'Runs In The Browser',
    copy: 'No install, no drivers, no dongles. Open the page and play.',
  },
  {
    icon: Gauge,
    title: 'Tunable Dwell',
    copy: 'Set the dwell time and smoothing that suit your control, not an average.',
  },
  {
    icon: Sparkles,
    title: 'Readable Board',
    copy: 'High-contrast pieces and a green board designed to be read at a glance.',
  },
]

const ACCESS_POINTS = [
  {
    icon: Accessibility,
    title: 'Hands-free by default',
    copy: 'Every part of a game — selecting, moving, confirming — is reachable with gaze and a blink alone.',
  },
  {
    icon: Keyboard,
    title: 'Keyboard-first controls',
    copy: 'F for fullscreen eye control, C to recalibrate, V to flip the board. No small targets to hit.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Yours to tune',
    copy: 'Dwell time, cursor size, smoothing and reduced motion all live in one settings panel.',
  },
]

const POWERED_BY = ['MediaPipe', 'python-chess', 'Stockfish']

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5 } },
}

const stagger = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0912] text-foreground">
      <LandingNav />

      {/* ---------------------------------------------------------------- Hero */}
      <section className="relative overflow-hidden">
        {/* Ambient glow. Purely decorative, and kept behind everything so it can
            never intercept a click from someone aiming with a head pointer. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(60rem 32rem at 78% 12%, rgba(124,58,237,0.20), transparent 65%), radial-gradient(48rem 28rem at 8% 0%, rgba(59,130,246,0.10), transparent 60%)',
          }}
        />

        <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-14 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:px-8 lg:py-20">
          {/* Left column — the pitch. */}
          <motion.div initial="hidden" animate="show" variants={stagger} className="space-y-8">
            <motion.h1
              variants={fadeUp}
              className="text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
            >
              Play Chess
              <br />
              With{' '}
              <span className="bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent">
                Your Eyes
              </span>
            </motion.h1>

            <motion.div variants={fadeUp} className="space-y-4">
              <p className="text-xl text-muted-foreground sm:text-2xl">
                No hands. No mouse. Just your gaze.
              </p>
              <p className="max-w-xl text-base leading-relaxed text-muted-foreground/90">
                Eye Gaze Chess lets you play the world&rsquo;s greatest game using only your eyes.
                Built for people with ALS, cerebral palsy, or severe motor impairments.
              </p>
            </motion.div>

            <motion.div variants={fadeUp} className="flex flex-col gap-3 sm:flex-row">
              <Link href="/game">
                <Button
                  size="lg"
                  className="h-14 w-full gap-2 rounded-xl bg-primary px-8 text-base font-semibold hover:bg-accent sm:w-auto"
                >
                  <Play className="h-5 w-5 fill-current" />
                  Start Playing
                </Button>
              </Link>
              <a href="#how-it-works">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-14 w-full gap-2 rounded-xl border-white/15 px-8 text-base font-semibold hover:bg-white/5 sm:w-auto"
                >
                  <Info className="h-5 w-5" />
                  Learn More
                </Button>
              </a>
            </motion.div>

            <motion.ul variants={fadeUp} className="grid gap-4 pt-2 sm:grid-cols-3">
              {HERO_POINTS.map(({ icon: Icon, title, copy }) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{title}</span>
                    <span className="block text-xs text-muted-foreground">{copy}</span>
                  </span>
                </li>
              ))}
            </motion.ul>

            <motion.p variants={fadeUp} className="text-sm text-muted-foreground">
              <Link href="/signup" className="font-medium text-primary hover:underline">
                Create an account
              </Link>{' '}
              to keep your games and calibration, or{' '}
              <Link href="/signin" className="font-medium text-primary hover:underline">
                sign in
              </Link>
              . You can also just start playing.
            </motion.p>
          </motion.div>

          {/* Right column — what the tracker sees, and where it lands. */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="relative"
          >
            {/* "Gaze Detected" readout, mirroring the panel shown during a game. */}
            <div className="mb-4 flex justify-center lg:absolute lg:-top-6 lg:left-0 lg:z-30 lg:mb-0 lg:justify-start">
              <div className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-[#14111f]/95 px-4 py-3 shadow-xl backdrop-blur">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
                  <Eye className="h-5 w-5 text-primary" />
                </span>
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    Gaze Detected
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                  </span>
                  <span className="block text-sm text-primary">Looking at E4</span>
                </span>
              </div>
            </div>

            <div className="relative flex items-center">
              {/* Beam from the eye to the square being looked at. Percentage
                  coordinates with a non-scaling stroke, so it stays a hairline
                  at every width instead of stretching with the box. */}
              <svg
                aria-hidden
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 z-20 hidden h-full w-full lg:block"
              >
                <defs>
                  <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="rgba(196,181,253,0)" />
                    <stop offset="35%" stopColor="rgba(167,139,250,0.75)" />
                    <stop offset="100%" stopColor="rgba(216,180,254,1)" />
                  </linearGradient>
                </defs>
                <line
                  x1="21"
                  y1="45"
                  x2="73"
                  y2="56"
                  stroke="url(#beam)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                />
              </svg>

              {/* Face. Hidden below lg, where the board alone tells the story. */}
              <div className="relative z-10 hidden aspect-square w-[36%] shrink-0 overflow-hidden rounded-full border-2 border-primary/40 bg-[#100d19] shadow-2xl lg:block">
                <FaceMesh className="h-full w-full" />
              </div>

              <div className="relative z-0 min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#12101c] p-3 shadow-2xl lg:-ml-8 lg:p-4">
                <MiniBoard />
              </div>
            </div>
          </motion.div>
        </div>

        {/* ------------------------------------------------ Inclusion + credits */}
        <div className="mx-auto max-w-7xl px-5 pb-6 lg:px-8">
          <div className="flex flex-col gap-6 rounded-2xl border border-white/10 bg-white/[0.03] p-6 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Heart className="h-5 w-5 text-primary" />
              </span>
              <div>
                <p className="text-base font-semibold text-foreground">
                  Designed for inclusion. Built for independence.
                </p>
                <p className="text-sm text-muted-foreground">
                  Eye Gaze Chess empowers people who have never been able to play chess before.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-white/10 lg:flex-row lg:items-center lg:gap-8 lg:border-l lg:pl-10">
              <span className="text-sm text-muted-foreground">Powered by</span>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
                {POWERED_BY.map((name) => (
                  <span key={name} className="text-sm font-medium text-foreground/90">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- How it works */}
      <section id="how-it-works" className="mx-auto max-w-7xl scroll-mt-24 px-5 pb-16 lg:px-8">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          className="grid gap-8 rounded-2xl border border-white/10 bg-white/[0.03] p-8 lg:grid-cols-[minmax(0,18rem)_1fr] lg:items-center lg:gap-12"
        >
          <motion.div variants={fadeUp}>
            <h2 className="text-3xl font-bold tracking-tight">How It Works</h2>
            <p className="mt-2 text-muted-foreground">Simple. Intuitive. Powerful.</p>
            <Link
              href="/calibration"
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
            >
              Calibrate your camera →
            </Link>
          </motion.div>

          <motion.ol variants={stagger} className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {STEPS.map(({ icon: Icon, title, copy }) => (
              <motion.li key={title} variants={fadeUp} className="flex gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                  <Icon className="h-6 w-6 text-primary" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-primary">{title}</span>
                  <span className="block text-sm leading-relaxed text-muted-foreground">{copy}</span>
                </span>
              </motion.li>
            ))}
          </motion.ol>
        </motion.div>
      </section>

      {/* ------------------------------------------------- Before you start */}
      <section id="before-you-start" className="mx-auto max-w-7xl scroll-mt-24 px-5 pb-16 lg:px-8">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          className="rounded-2xl border-2 border-primary/60 bg-primary/[0.06] p-8"
        >
          <motion.div variants={fadeUp} className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              Before you start
            </h2>
            <p className="mt-2 text-lg text-foreground/90">
              Four things to get right first. They take a minute, and they are the difference
              between calibrating once and calibrating three times.
            </p>
          </motion.div>

          <motion.ol variants={stagger} className="mt-8 grid gap-6 sm:grid-cols-2">
            {BEFORE_YOU_START.map(({ icon: Icon, title, copy }) => (
              <motion.li key={title} variants={fadeUp} className="flex gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <Icon className="h-6 w-6" />
                </span>
                <span className="min-w-0">
                  <span className="block text-lg font-bold text-foreground">{title}</span>
                  <span className="block text-base leading-relaxed text-foreground/80">{copy}</span>
                </span>
              </motion.li>
            ))}
          </motion.ol>
        </motion.div>
      </section>

      {/* ------------------------------------------------------------ Features */}
      <section
        id="features"
        className="scroll-mt-24 border-t border-white/5 bg-[#0c0a15] px-5 py-20 lg:px-8"
      >
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.15 }}
          className="mx-auto max-w-7xl"
        >
          <motion.div variants={fadeUp} className="mb-12 max-w-2xl">
            <h2 className="text-4xl font-bold tracking-tight sm:text-5xl">
              Everything the board needs
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Real eye tracking, a real engine, and a board built to be read — not squinted at.
            </p>
          </motion.div>

          <motion.div variants={stagger} className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, copy }) => (
              <motion.article
                key={title}
                variants={fadeUp}
                whileHover={{ y: -4 }}
                className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-primary/40"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                <div className="relative space-y-4">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 transition-colors group-hover:bg-primary/20">
                    <Icon className="h-6 w-6 text-primary" />
                  </span>
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{copy}</p>
                </div>
              </motion.article>
            ))}
          </motion.div>
        </motion.div>
      </section>

      {/* ------------------------------------------------------- Accessibility */}
      <section id="accessibility" className="scroll-mt-24 px-5 py-20 lg:px-8">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.15 }}
          className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-2 lg:items-center"
        >
          <motion.div variants={fadeUp} className="space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <Accessibility className="h-3.5 w-3.5" />
              Accessibility
            </span>
            <h2 className="text-4xl font-bold tracking-tight sm:text-5xl">
              The whole game, without a hand on the mouse
            </h2>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Eye control runs fullscreen, so every square is large enough for gaze to land on it
              reliably. Nothing commits without a deliberate blink, and every timing that matters is
              yours to change.
            </p>
          </motion.div>

          <motion.ul variants={stagger} className="space-y-4">
            {ACCESS_POINTS.map(({ icon: Icon, title, copy }) => (
              <motion.li
                key={title}
                variants={fadeUp}
                className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                  <Icon className="h-5 w-5 text-primary" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-sm leading-relaxed text-muted-foreground">{copy}</span>
                </span>
              </motion.li>
            ))}
          </motion.ul>
        </motion.div>
      </section>

      {/* --------------------------------------------------------------- About */}
      <section
        id="about"
        className="scroll-mt-24 border-t border-white/5 bg-[#0c0a15] px-5 py-20 lg:px-8"
      >
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          className="mx-auto max-w-3xl space-y-6 text-center"
        >
          <motion.h2 variants={fadeUp} className="text-4xl font-bold tracking-tight">
            Ready to play?
          </motion.h2>
          <motion.p variants={fadeUp} className="text-lg leading-relaxed text-muted-foreground">
            Eye Gaze Chess was built so that a webcam and an ordinary browser are enough to sit down
            at a real board against a real engine. No hardware to buy, no setup to survive — open the
            game, calibrate once, and play.
          </motion.p>
          <motion.div variants={fadeUp} className="flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/game">
              <Button
                size="lg"
                className="h-14 w-full gap-2 rounded-xl bg-primary px-8 text-base font-semibold hover:bg-accent sm:w-auto"
              >
                <Play className="h-5 w-5 fill-current" />
                Launch Game
              </Button>
            </Link>
            <Link href="/calibration">
              <Button
                size="lg"
                variant="outline"
                className="h-14 w-full rounded-xl border-white/15 px-8 text-base font-semibold hover:bg-white/5 sm:w-auto"
              >
                Calibrate Camera
              </Button>
            </Link>
          </motion.div>
        </motion.div>
      </section>

      <footer className="border-t border-white/5 px-5 py-8 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
          <span className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" />
            Eye Gaze Chess
          </span>
          <span>Accessibility first, always.</span>
        </div>
      </footer>
    </main>
  )
}
