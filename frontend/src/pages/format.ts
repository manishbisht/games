const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })

/** "just now", "5 min. ago", "yesterday", "3 days ago" — and a date past a month. */
export function timeAgo(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000)
  if (Math.abs(seconds) < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return relative.format(days, 'day')
  return new Date(at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "1st", "2nd", "3rd", "4th". */
export function ordinal(place: number): string {
  const tens = place % 100
  if (tens >= 11 && tens <= 13) return `${place}th`
  return `${place}${['th', 'st', 'nd', 'rd'][place % 10] ?? 'th'}`
}

/** "Ben", "Ben and Cleo", "Ben, Cleo and Milo". */
export function names(list: string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(list)
}
