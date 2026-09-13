/**
 * The only decision a seat makes over the wire. Everything else a turn is made
 * of — the die landing, the token walking, a snake or a ladder carrying it away,
 * the turn passing on — is a timed beat the server paces for the whole table
 * (see `./adapter`). Snakes and ladders asks nothing else of a player, which is
 * why an online table can never sit deadlocked on one.
 */
export type WildriseOnlineAction = { kind: 'roll' }
