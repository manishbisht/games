import { botName } from '../online/bots'

/**
 * The only decision a seat makes over the wire. Everything else a turn is made
 * of — the die landing, the token walking, a snake or a ladder carrying it away,
 * the turn passing on — is a timed beat the server paces for the whole table
 * (see `./adapter`). Snakes and ladders asks nothing else of a player, which is
 * why an online table can never sit deadlocked on one.
 */
export type WildriseOnlineAction = { kind: 'roll' }

/**
 * The names the room will give the seats it plays at a solo table, so the setup
 * can introduce the companions by the names they will actually answer to.
 */
export const companionNames = (count: number) => Array.from({ length: count }, (_, i) => botName(i))
