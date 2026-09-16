'use client'

import { motion } from 'framer-motion'
import { RotateCcw, Zap, Settings, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

interface LeftSidebarProps {
  difficulty: string
  timer: number
  onNewGame: () => void
  onRestartGame: () => void
  onSettings: () => void
}

export default function LeftSidebar({
  difficulty,
  timer,
  onNewGame,
  onRestartGame,
  onSettings,
}: LeftSidebarProps) {
  const minutes = Math.floor(timer / 60)
  const seconds = timer % 60

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full flex flex-col gap-6 p-6 bg-card border-r border-border rounded-lg"
    >
      {/* Game Status */}
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
            Difficulty
          </p>
          <p className="text-lg font-bold text-foreground capitalize">{difficulty}</p>
        </div>

        {/* Timer */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
            Time
          </p>
          <motion.p
            key={timer}
            initial={{ scale: 1.1 }}
            animate={{ scale: 1 }}
            className="text-2xl font-mono font-bold text-primary"
          >
            {minutes.toString().padStart(2, '0')}:{seconds.toString().padStart(2, '0')}
          </motion.p>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Controls */}
      <div className="space-y-3 flex-1">
        <Button
          onClick={onNewGame}
          size="sm"
          variant="outline"
          className="w-full justify-start gap-2 text-sm"
        >
          <Zap className="w-4 h-4" />
          New Game
        </Button>

        <Button
          onClick={onRestartGame}
          size="sm"
          variant="outline"
          className="w-full justify-start gap-2 text-sm"
        >
          <RotateCcw className="w-4 h-4" />
          Restart
        </Button>

        <Link href="/calibration" className="w-full">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start gap-2 text-sm"
          >
            <Eye className="w-4 h-4" />
            Calibrate
          </Button>
        </Link>

        <Button
          onClick={onSettings}
          size="sm"
          variant="outline"
          className="w-full justify-start gap-2 text-sm"
        >
          <Settings className="w-4 h-4" />
          Settings
        </Button>
      </div>

      {/* Footer Info */}
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Press F for eye control</p>
        <p>Three looks pick a square</p>
        <p>Press H for the instructions</p>
      </div>
    </motion.div>
  )
}
