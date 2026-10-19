import type { Cue } from '../scene/createScene'

export type CueKind = Exclude<Cue['kind'], 'sound'>
/** The newest cue of each kind, keyed so a repeat of the same moment replays its animation. */
export type Cues = Partial<Record<CueKind, Cue & { key: number }>>

/** The newest cue of `kind`, if it is about `player`. */
export function cueFor<K extends CueKind>(cues: Cues, kind: K, player: number) {
  const cue = cues[kind] as (Extract<Cue, { kind: K }> & { key: number }) | undefined
  return cue && 'player' in cue && cue.player === player ? cue : null
}

/** `cues` with `cue` as the newest of its kind. A penalty counting its cards in is one moment, not one per card. */
export function withCue(cues: Cues, cue: Exclude<Cue, { kind: 'sound' }>): Cues {
  const previous = cues[cue.kind]
  const same =
    cue.kind === 'penalty' && previous?.kind === 'penalty' && previous.player === cue.player && cue.landed > 0
  return { ...cues, [cue.kind]: { ...cue, key: same ? previous.key : (previous?.key ?? 0) + 1 } }
}
