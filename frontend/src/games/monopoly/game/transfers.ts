/** Where money went between two balances: a player index, or `BANK` for the board. */
export const BANK = -1

export interface Transfer {
  from: number
  to: number
  amount: number
}

/**
 * Reads who paid whom off two sets of balances. A loss matched by an equal gain
 * elsewhere is rent or a trade, player to player; anything left over went to or
 * came from the bank. The sidebar's coins and the board's coins both fly these,
 * so they always agree about where the money went.
 */
export function transfers(before: readonly number[], after: readonly number[]): Transfer[] {
  if (before.length !== after.length) return []
  const deltas = after.map((value, i) => value - before[i]),
    paid = new Set<number>(),
    out: Transfer[] = []
  deltas.forEach((delta, payer) => {
    if (delta >= 0) return
    const payee = deltas.findIndex((d, i) => d === -delta && i !== payer && !paid.has(i))
    if (payee >= 0) paid.add(payee)
    out.push({ from: payer, to: payee >= 0 ? payee : BANK, amount: -delta })
  })
  deltas.forEach((delta, player) => {
    if (delta > 0 && !paid.has(player)) out.push({ from: BANK, to: player, amount: delta })
  })
  return out
}

/** How many coins a payment is worth showing: three for pocket change, seven for a hotel's rent. */
export const coinCount = (amount: number) =>
  Math.min(7, 3 + Math.round(Math.log10(Math.max(10, amount)) * 1.2))
/** The gap between one coin of a payment and the next, in ms. */
export const COIN_STAGGER = 65
