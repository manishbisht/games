import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

export class RoomDO extends DurableObject<Env> {}
