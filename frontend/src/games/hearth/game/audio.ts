import { haptic, noise, sounds, tone } from '../../../motion/audio'
import type { Cue } from '../scene/types'

/**
 * Hearth's sounds, built on the site's one audio engine: a lacquered wooden
 * die rattled in a cupped hand and dropped into a felt tray, turned wooden
 * pieces tapping across a painted board, a hard clack when one knocks
 * another home, and bells for a piece coming home. Everything is quiet and
 * short; the room reverb does the rest.
 */

/** A small wooden tap: a piece on the board, a die against another die. */
function tap(pitch: number, volume: number, pan = 0, at = 0) {
  tone({
    freq: 540 * pitch,
    to: 300 * pitch,
    type: 'triangle',
    duration: 0.055,
    volume: 0.032 * volume,
    cutoff: 2600,
    pan,
    at,
    room: 0.12,
  })
  noise({ duration: 0.018, volume: 0.018 * volume, freq: 3400 * pitch, q: 2.2, pan, at })
}

/** Felt under a falling object: a soft, low pad of air. */
function felt(strength: number, pan = 0) {
  noise({ duration: 0.07, volume: 0.035 * strength, freq: 420, to: 140, filter: 'lowpass', pan })
}

export function playCue(cue: Cue) {
  switch (cue.kind) {
    case 'roll':
      // The die rattling in a cupped hand: a run of uneven little clicks.
      for (let i = 0; i < 6; i++)
        tap(1.5 + Math.random() * 0.5, 0.45 + Math.random() * 0.35, 0.35, i * 0.065 + Math.random() * 0.02)
      break
    case 'dice':
      sounds.knock(0.35 + cue.strength * 0.6, 0.8, cue.pan)
      felt(cue.strength, cue.pan)
      break
    case 'step':
      // Each hop a touch higher than the last, as the piece runs on.
      tap(1 + Math.min(cue.index, 8) * 0.045, 1, cue.pan)
      break
    case 'land':
      sounds.knock(0.85, 1.15, cue.pan)
      felt(0.6, cue.pan)
      break
    case 'capture':
      // The hit, the victim knocked into the air, and its landing back in the nest.
      sounds.thud(0.85, 1, cue.pan)
      sounds.knock(1, 1.6, cue.pan)
      noise({ duration: 0.4, volume: 0.03, freq: 500, to: 2200, q: 0.8, attack: 0.16, at: 0.1, room: 0.15 })
      tap(0.9, 0.9, 0, 0.88)
      break
    case 'home':
      sounds.chime([523, 659, 784], 0.1)
      sounds.sparkle(0.8)
      break
    case 'win':
      sounds.fanfare()
      break
  }
}

/** The few moments worth feeling in the hand: the die landing, a capture, the win. */
export function feelCue(cue: Cue) {
  if (cue.kind === 'dice' && cue.strength >= 1) haptic(10)
  else if (cue.kind === 'capture') haptic([16, 50, 22])
  else if (cue.kind === 'win') haptic([20, 60, 20, 60, 45])
}

/** A soft knock when the sound comes on, so the player hears that it did. */
export const soundCheck = () => sounds.knock(0.6, 1.1)
