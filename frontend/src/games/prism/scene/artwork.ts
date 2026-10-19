import { createDeck } from '@games/shared/prism'
import type { Card } from '@games/shared/prism/types'
import { COLOR_HEX } from '@games/shared/prism/types'

/**
 * A card the viewer may not see. The room redacts hidden cards to a shape-valid
 * placeholder (a red 0 labelled "Hidden"); drawing that face would put a card
 * on the table that was never played, so anything hidden wears the back.
 */
export const isHidden = (card?: Card) =>
  !card || card.id.startsWith('hidden-') || card.visual.label === 'Hidden'
export const artKey = (card?: Card) => (isHidden(card) ? 'back' : `${card!.color}-${card!.value}`)

const artwork = new Map<string, HTMLCanvasElement>()
export function cardArtwork(card?: Card): HTMLCanvasElement {
  const key = artKey(card)
  const cached = artwork.get(key)
  if (cached) return cached
  const face = key === 'back' ? undefined : card
  const canvas = document.createElement('canvas')
  canvas.width = 384
  canvas.height = 576
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#f5f0df'
  ctx.beginPath()
  ctx.roundRect(0, 0, 384, 576, 24)
  ctx.fill()
  ctx.fillStyle = face ? COLOR_HEX[face.color] : '#183e37'
  ctx.beginPath()
  ctx.roundRect(15, 15, 354, 546, 16)
  ctx.fill()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(15, 15, 354, 546, 16)
  ctx.clip()
  if (face?.isWild) {
    const colors = ['#e46051', '#e9b849', '#53a886', '#548cce']
    colors.forEach((color, i) => {
      ctx.save()
      ctx.translate(192, 288)
      ctx.rotate((i * Math.PI) / 2)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-215, -320)
      ctx.lineTo(215, -320)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    })
  }
  const gradient = ctx.createLinearGradient(0, 0, 384, 576)
  gradient.addColorStop(0, '#ffffff15')
  gradient.addColorStop(1, '#00000020')
  ctx.fillStyle = gradient
  ctx.fillRect(15, 15, 354, 546)
  ctx.translate(192, 288)
  ctx.strokeStyle = face ? '#fff6db45' : '#d6bb8055'
  ctx.lineWidth = 1.6
  for (let i = 0; i < 7; i++) {
    ctx.save()
    ctx.rotate(Math.PI / 4)
    const size = 127 + i * 25
    ctx.beginPath()
    ctx.roundRect(-size / 2, -size / 2, size, size, 10 + i * 2)
    ctx.stroke()
    ctx.restore()
  }
  ctx.restore()
  ctx.fillStyle = '#fff9e9'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (face) {
    ctx.shadowColor = '#00000025'
    ctx.shadowBlur = 10
    ctx.shadowOffsetY = 5
    ctx.font = `700 ${face.visual.symbol.length > 1 ? 128 : 180}px Arial, sans-serif`
    ctx.fillText(face.visual.symbol, 192, 282)
    ctx.shadowColor = 'transparent'
    ctx.font = '700 36px Arial, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(face.visual.symbol, 35, 57)
    ctx.font = '500 12px Arial, sans-serif'
    ctx.fillText(face.isWild ? 'ANY COLOR' : face.color.toUpperCase(), 36, 88)
    ctx.save()
    ctx.translate(349, 520)
    ctx.rotate(Math.PI)
    ctx.font = '700 36px Arial, sans-serif'
    ctx.fillText(face.visual.symbol, 0, 0)
    ctx.restore()
    ctx.textAlign = 'center'
    ctx.font = '600 16px Arial, sans-serif'
    ctx.fillText(face.visual.label.toUpperCase(), 192, 442)
    ctx.fillStyle = '#fff9e9b0'
    ctx.font = '500 12px Arial, sans-serif'
    ctx.fillText('P  R  I  S  M', 192, 481)
  } else {
    ctx.fillStyle = '#e8d7a7'
    ctx.font = '400 103px Georgia, serif'
    ctx.fillText('✦', 192, 261)
    ctx.font = '600 23px Arial, sans-serif'
    ctx.fillText('P R I S M', 192, 341)
    ctx.font = '500 10px Arial, sans-serif'
    ctx.fillStyle = '#e8d7a780'
    ctx.fillText('A LITTLE COLOR. A LITTLE CHAOS.', 192, 515)
  }
  artwork.set(key, canvas)
  return canvas
}

const images = new Map<string, string>()
/**
 * The same artwork as an <img> source. Warmed in idle time as blob URLs, whose
 * PNG encode runs off the main thread; a card asked for before then still gets
 * one, synchronously, rather than a blank.
 */
export function cardImage(card?: Card) {
  const key = artKey(card)
  let url = images.get(key)
  if (!url) images.set(key, (url = cardArtwork(card).toDataURL()))
  return url
}

/** One of each face, plus the back: everything a table can ever show. */
export function everyFace(): (Card | undefined)[] {
  const seen = new Set<string>(),
    faces: (Card | undefined)[] = [undefined]
  for (const card of createDeck()) {
    const key = artKey(card)
    if (seen.has(key)) continue
    seen.add(key)
    faces.push(card)
  }
  return faces
}

type Idle = (callback: (deadline?: { timeRemaining(): number }) => void) => number
const idle: Idle =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (callback) => window.requestIdleCallback(callback, { timeout: 1500 })
    : (callback) => window.setTimeout(() => callback(), 16)
const cancelIdle = (id: number) =>
  typeof window !== 'undefined' && 'cancelIdleCallback' in window
    ? window.cancelIdleCallback(id)
    : clearTimeout(id)

/**
 * Paints `faces` a few at a time while the browser is idle, calling `each` for
 * every one, so no card is ever painted for the first time mid-flight. Returns
 * a cancel.
 */
export function warm(faces: (Card | undefined)[], each: (card: Card | undefined) => void) {
  let index = 0,
    handle = 0,
    cancelled = false
  const work = (deadline?: { timeRemaining(): number }) => {
    if (cancelled) return
    do {
      const card = faces[index++]
      cardArtwork(card)
      each(card)
    } while (index < faces.length && (deadline ? deadline.timeRemaining() > 4 : index % 3))
    if (index < faces.length) handle = idle(work)
  }
  handle = idle(work)
  return () => {
    cancelled = true
    cancelIdle(handle)
  }
}

let imagesWarmed = false
/** Encodes every face's <img> source in the background, once per visit. */
export function warmImages() {
  if (imagesWarmed || typeof document === 'undefined') return
  imagesWarmed = true
  warm(everyFace(), (card) => {
    const key = artKey(card)
    if (images.has(key)) return
    cardArtwork(card).toBlob((blob) => {
      if (blob && !images.has(key)) images.set(key, URL.createObjectURL(blob))
    })
  })
}
