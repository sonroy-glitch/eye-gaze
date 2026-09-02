import { EyeTrackingState, AccessibilitySettings } from './types'

export const createInitialEyeTrackingState = (): EyeTrackingState => {
  const gazePoint = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    confidence: 0.95,
  }
  return {
    status: 'active',
    rawGazePoint: gazePoint,
    correctedGazePoint: gazePoint,
    gazePoint,
    blinkDetected: false,
    calibrationProgress: 100,
    isCalibrated: true,
    calibrationQuality: 1,
    calibrationErrorSquares: 0,
    trackingIssue: null,
    cameraPermission: 'granted',
    headDrift: null,
  }
}

export const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilitySettings = {
  // 700ms is conservative for chess: long enough that a glance passing over a
  // square can't trigger it, short enough that deliberate selection stays usable.
  // Tunable between 500 and 1000ms in settings.
  dwellTime: 700,
  // Fairly heavy smoothing by default so the cursor sits steady; users on a good
  // webcam can lower it for snappier tracking.
  smoothing: 70,
  blinkSensitivity: 'medium',
  highContrast: false,
  largeCursor: false,
  reducedMotion: false,
  voiceFeedback: false,
}

// Simulate gaze movement around the screen
export const generateMockGazeTrajectory = (
  centerX: number = window.innerWidth / 2,
  centerY: number = window.innerHeight / 2,
  radius: number = 300
) => {
  const points = []
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * Math.PI * 2
    const x = centerX + Math.cos(angle) * radius
    const y = centerY + Math.sin(angle) * radius
    const confidence = 0.8 + Math.random() * 0.2
    points.push({ x: Math.max(0, Math.min(window.innerWidth, x)), y: Math.max(0, Math.min(window.innerHeight, y)), confidence })
  }
  return points
}
