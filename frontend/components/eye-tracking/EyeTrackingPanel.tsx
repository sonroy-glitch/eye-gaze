'use client'

import { motion } from 'framer-motion'
import { Eye, AlertCircle, CheckCircle2, Maximize2, RefreshCw, Bug } from 'lucide-react'
import { EyeTrackingState } from '@/lib/eye-tracking/types'

interface EyeTrackingPanelProps {
  eyeTrackingState: EyeTrackingState
  /** Enter fullscreen eye control (starts the tracker, shows calibration if needed). */
  onStartEyeControl: () => void
  onRecalibrate: () => void
  onToggleDebug: () => void
  debugEnabled: boolean
  isReady: boolean
  error: string | null
  /** True once a board-specific calibration correction model exists. */
  hasCalibration: boolean
  /** How many calibration samples have been collected this session. */
  calibrationSampleCount: number
  /** The square the gaze currently resolves to, in algebraic notation. */
  targetSquare?: string | null
  /** 0..1 confidence in that square. */
  targetConfidence?: number
  /** Resolution the webcam actually negotiated. */
  cameraResolution?: { width: number; height: number } | null
  /** Detection throughput, gaze results per second. */
  fps?: number
}

export default function EyeTrackingPanel({
  eyeTrackingState,
  onStartEyeControl,
  onRecalibrate,
  onToggleDebug,
  debugEnabled,
  isReady,
  error,
  hasCalibration,
  calibrationSampleCount,
  targetSquare = null,
  targetConfidence = 0,
  cameraResolution = null,
  fps = 0,
}: EyeTrackingPanelProps) {
  const isActive = eyeTrackingState.status === 'active'
  const statusColor = isActive ? 'text-green-400' : 'text-yellow-400'
  const statusBgColor = isActive ? 'bg-green-400/10' : 'bg-yellow-400/10'

  const statusText =
    eyeTrackingState.status === 'inactive'
      ? 'Inactive'
      : eyeTrackingState.status === 'calibrating'
        ? 'Calibrating'
        : eyeTrackingState.status === 'lost'
          ? 'Signal Lost'
          : 'Tracking Active'
  const calibrationText = eyeTrackingState.calibrationErrorSquares
    ? `${eyeTrackingState.calibrationErrorSquares.toFixed(2)} squares median validation error`
    : null

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      className="h-full flex flex-col gap-4 p-6 bg-card border-l border-border rounded-lg"
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Eye className="w-5 h-5 text-primary" />
        <h3 className="font-semibold text-foreground">Eye Tracking</h3>
      </div>

      {/* Powered-by note — this is WebEyeTrack now, calibrated by looking + clicking. */}
      <p className="text-xs text-muted-foreground">
        Gaze runs only in <span className="text-foreground font-medium">fullscreen</span>,
        where the board is large enough to select squares by eye.
      </p>

      {/* Enter eye control */}
      <motion.button
        onClick={onStartEyeControl}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary hover:bg-accent text-primary-foreground text-sm font-medium transition-colors"
      >
        <Maximize2 className="w-4 h-4" />
        {isReady ? (hasCalibration ? 'Enter eye control' : 'Calibrate in fullscreen') : 'Start eye control'}
      </motion.button>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onRecalibrate}
          className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Recalibrate
        </button>
        <button
          type="button"
          onClick={onToggleDebug}
          aria-pressed={debugEnabled}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
            debugEnabled
              ? 'border-primary bg-primary/15 text-primary'
              : 'border-border bg-muted text-muted-foreground hover:text-foreground'
          }`}
        >
          <Bug className="w-3.5 h-3.5" />
          Debug
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/80">
        Press <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono">F</kbd> to
        toggle, <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono">C</kbd> to
        recalibrate. Video never leaves this device.
      </p>
      {error && (
        <p className="text-xs text-red-400 flex items-start gap-1">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {/* Status Badge */}
      <motion.div
        animate={{ opacity: [1, 0.8, 1] }}
        transition={{ duration: 2, repeat: Infinity }}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg ${statusBgColor} text-sm`}
      >
        {isActive ? (
          <CheckCircle2 className={`w-4 h-4 ${statusColor}`} />
        ) : (
          <AlertCircle className={`w-4 h-4 ${statusColor}`} />
        )}
            <span className={statusColor}>{statusText}</span>
      </motion.div>
      {eyeTrackingState.trackingIssue && (
        <p className="text-xs text-yellow-400">
          {eyeTrackingState.trackingIssue.replaceAll('-', ' ')}
        </p>
      )}

      {/* Confidence Meter */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-muted-foreground uppercase">Confidence</p>
          <motion.p
            key={eyeTrackingState.gazePoint.confidence}
            initial={{ scale: 1.1 }}
            animate={{ scale: 1 }}
            className="text-sm font-bold text-primary"
          >
            {Math.round(eyeTrackingState.gazePoint.confidence * 100)}%
          </motion.p>
        </div>
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${eyeTrackingState.gazePoint.confidence * 100}%` }}
            transition={{ duration: 0.3 }}
            className="h-full bg-gradient-to-r from-primary to-accent rounded-full"
          />
        </div>
      </div>

      {/* Target square — the actual output of the pipeline. */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase">Target square</p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold font-mono text-foreground tabular-nums">
            {targetSquare ?? '—'}
          </span>
          <span className="text-sm font-semibold text-primary">
            {targetSquare ? `${Math.round(targetConfidence * 100)}%` : ''}
          </span>
        </div>
      </div>

      {/* Calibration state */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase">Calibration</p>
        {hasCalibration ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-green-400">Calibrated</span> ·{' '}
            {calibrationSampleCount} samples
            {calibrationText ? ` · ${calibrationText}` : ''}
          </p>
        ) : (
          <p className="text-xs text-yellow-400">
            Not calibrated. Enter eye control and look at the targets
            {calibrationSampleCount > 0 ? ` (${calibrationSampleCount} so far)` : ''}.
          </p>
        )}
      </div>

      {/* Blink Indicator */}
      <motion.div
        animate={{
          backgroundColor: eyeTrackingState.blinkDetected
            ? 'rgba(168, 85, 247, 0.1)'
            : 'transparent',
        }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
      >
        <motion.div
          animate={{
            scale: eyeTrackingState.blinkDetected ? 1.2 : 1,
            backgroundColor: eyeTrackingState.blinkDetected
              ? 'rgb(168, 85, 247)'
              : 'rgb(100, 116, 139)',
          }}
          className="w-2 h-2 rounded-full"
        />
        <span className="text-muted-foreground">
          {eyeTrackingState.blinkDetected ? 'Blink detected' : 'Ready'}
        </span>
      </motion.div>

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Camera / throughput */}
      <div className="text-xs text-muted-foreground space-y-2">
        {cameraResolution && (
          <p>
            Capture:{' '}
            <span className="text-foreground">
              {cameraResolution.width}×{cameraResolution.height}
            </span>
            {fps > 0 && <span> · {fps} fps</span>}
          </p>
        )}
        <p>
          Camera:{' '}
          <span
            className={
              eyeTrackingState.cameraPermission === 'granted'
                ? 'text-green-400'
                : 'text-yellow-400'
            }
          >
            {eyeTrackingState.cameraPermission}
          </span>
        </p>
      </div>
    </motion.div>
  )
}
