'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Volume2, Eye, Accessibility, Zap, Timer } from 'lucide-react'
import { AccessibilitySettings } from '@/lib/eye-tracking/types'
import { DEFAULT_ACCESSIBILITY_SETTINGS } from '@/lib/eye-tracking/mock-data'
import { Button } from '@/components/ui/button'

interface AccessibilityMenuProps {
  isOpen: boolean
  onClose: () => void
  settings: AccessibilitySettings
  onSettingsChange: (settings: AccessibilitySettings) => void
}

export default function AccessibilityMenu({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
}: AccessibilityMenuProps) {
  const handleDwellTimeChange = (value: string) => {
    onSettingsChange({
      ...settings,
      dwellTime: parseInt(value),
    })
  }

  const handleGraceChange = (value: string) => {
    onSettingsChange({
      ...settings,
      postEngineGraceSeconds: parseInt(value),
    })
  }

  const handleSmoothingChange = (value: string) => {
    onSettingsChange({
      ...settings,
      smoothing: parseInt(value),
    })
  }

  const handleBlinkSensitivityChange = (value: string) => {
    onSettingsChange({
      ...settings,
      blinkSensitivity: value as 'low' | 'medium' | 'high',
    })
  }

  const toggleSetting = (key: keyof Omit<AccessibilitySettings, 'dwellTime' | 'blinkSensitivity'>) => {
    onSettingsChange({
      ...settings,
      [key]: !settings[key],
    })
  }

  const handleReset = () => {
    onSettingsChange(DEFAULT_ACCESSIBILITY_SETTINGS)
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
          />

          {/* Menu */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-card border border-border rounded-xl shadow-xl z-50 max-h-[90vh] overflow-y-auto p-6"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Accessibility className="w-6 h-6 text-primary" />
                <h2 className="text-xl font-bold text-foreground">Accessibility Settings</h2>
              </div>
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onClose}
                className="p-2 hover:bg-muted rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </motion.button>
            </div>

            {/* Settings */}
            <div className="space-y-6">
              {/* Dwell Time */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Eye className="w-4 h-4" />
                  Dwell Time (ms)
                </label>
                <p className="text-xs text-muted-foreground">
                  How long you hold each of the three looks that pick a square.
                </p>
                {/* Bounded to the range that works for gaze dwell: below ~500ms
                    a passing glance can trigger, above ~1000ms selection drags. */}
                <input
                  type="range"
                  min="500"
                  max="1000"
                  step="50"
                  value={settings.dwellTime}
                  onChange={(e) => handleDwellTimeChange(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>500ms</span>
                  <span className="font-mono">{settings.dwellTime}ms</span>
                  <span>1000ms</span>
                </div>
              </div>

              {/* Pause after the opponent moves. Without it the dwell starts
                  counting the instant the reply lands, on whatever square the
                  gaze happened to be resting on. */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Timer className="w-4 h-4" />
                  Pause After Opponent Moves
                </label>
                <p className="text-xs text-muted-foreground">
                  Time to read the new position before eye control starts again. Set 0 to turn
                  the pause off.
                </p>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="1"
                  value={settings.postEngineGraceSeconds}
                  onChange={(e) => handleGraceChange(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Off</span>
                  <span className="font-mono">
                    {settings.postEngineGraceSeconds === 0
                      ? 'Off'
                      : `${settings.postEngineGraceSeconds}s`}
                  </span>
                  <span>10s</span>
                </div>
              </div>

              {/* Cursor Smoothing — raise this if the gaze cursor feels jittery
                  or too sensitive; lower it for snappier tracking. */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Eye className="w-4 h-4" />
                  Cursor Smoothing
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={settings.smoothing}
                  onChange={(e) => handleSmoothingChange(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Responsive</span>
                  <span className="font-mono">{settings.smoothing}</span>
                  <span>Steady</span>
                </div>
              </div>

              {/* Blink Sensitivity */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Zap className="w-4 h-4" />
                  Blink Sensitivity
                </label>
                <p className="text-xs text-muted-foreground">
                  Only used when you turn the three-step selection off with Z. In the normal mode
                  the third look plays the move and blinking does nothing.
                </p>
                <div className="flex gap-2">
                  {['low', 'medium', 'high'].map((level) => (
                    <motion.button
                      key={level}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handleBlinkSensitivityChange(level)}
                      className={`flex-1 py-2 rounded-lg transition-colors text-sm font-medium capitalize ${
                        settings.blinkSensitivity === level
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      {level}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* Toggle Settings */}
              <div className="space-y-2">
                {[
                  {
                    key: 'highContrast',
                    label: 'High Contrast Mode',
                    description: 'Increase visual contrast for better visibility',
                  },
                  {
                    key: 'largeCursor',
                    label: 'Large Cursor',
                    description: 'Display larger gaze cursor',
                  },
                  {
                    key: 'reducedMotion',
                    label: 'Reduce Motion',
                    description: 'Minimize animations and transitions',
                  },
                  {
                    key: 'voiceFeedback',
                    label: 'Voice Feedback',
                    description: 'Speak actions and confirmations',
                  },
                ].map((setting) => (
                  <motion.button
                    key={setting.key}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() =>
                      toggleSetting(
                        setting.key as keyof Omit<
                          AccessibilitySettings,
                          'dwellTime' | 'blinkSensitivity'
                        >
                      )
                    }
                    className="w-full p-3 rounded-lg bg-muted hover:bg-muted/80 transition-colors text-left flex items-center justify-between"
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">{setting.label}</p>
                      <p className="text-xs text-muted-foreground">{setting.description}</p>
                    </div>
                    <motion.div
                      animate={{
                        backgroundColor: settings[setting.key as keyof AccessibilitySettings]
                          ? 'rgb(168, 85, 247)'
                          : 'rgb(100, 116, 139)',
                      }}
                      className="w-10 h-6 rounded-full flex items-center px-1"
                    >
                      <motion.div
                        animate={{
                          x: settings[setting.key as keyof AccessibilitySettings]
                            ? 16
                            : 0,
                        }}
                        className="w-4 h-4 bg-white rounded-full"
                      />
                    </motion.div>
                  </motion.button>
                ))}
              </div>

              {/* Divider */}
              <div className="h-px bg-border" />

              {/* Buttons */}
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={handleReset}
                >
                  Reset
                </Button>
                <Button
                  className="flex-1 bg-primary hover:bg-accent"
                  onClick={onClose}
                >
                  Done
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
