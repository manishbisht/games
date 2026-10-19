/**
 * The handful of things a player can say across the table without typing. A
 * fixed set rather than free text: nothing to moderate, nothing to translate,
 * and every one of them reads at a glance in a corner of a moving board.
 *
 * The id is what travels; emoji and label are the browser's to draw. Order is
 * the order a reaction bar offers them in.
 */
export const REACTIONS = [
  { id: 'gg', emoji: '🤝', label: 'Good game' },
  { id: 'nice', emoji: '👏', label: 'Nice one' },
  { id: 'wow', emoji: '😮', label: 'Wow' },
  { id: 'haha', emoji: '😄', label: 'Haha' },
  { id: 'ouch', emoji: '😬', label: 'Ouch' },
  { id: 'think', emoji: '🤔', label: 'Thinking' },
] as const

export type ReactionId = (typeof REACTIONS)[number]['id']

export function isReaction(value: unknown): value is ReactionId {
  return typeof value === 'string' && REACTIONS.some((reaction) => reaction.id === value)
}

/**
 * How often one socket may react: a bucket of `burst` that refills one token
 * every `refillMs`. Spectators get a smaller bucket — a crowd should be able to
 * cheer without drowning out the two people actually playing.
 */
export const REACTION_LIMITS = {
  seated: { burst: 3, refillMs: 1500 },
  watching: { burst: 2, refillMs: 4000 },
} as const
