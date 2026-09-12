import type { Card } from '@games/shared/prism/types'
import { COLOR_HEX } from '@games/shared/prism/types'

const artwork = new Map<string, HTMLCanvasElement>()
export function cardArtwork(card?: Card): HTMLCanvasElement {
  const key = card ? `${card.color}-${card.value}` : 'back'
  const cached = artwork.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 384
  canvas.height = 576
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#f5f0df'
  ctx.beginPath()
  ctx.roundRect(0, 0, 384, 576, 24)
  ctx.fill()
  ctx.fillStyle = card ? COLOR_HEX[card.color] : '#183e37'
  ctx.beginPath()
  ctx.roundRect(15, 15, 354, 546, 16)
  ctx.fill()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(15, 15, 354, 546, 16)
  ctx.clip()
  if (card?.isWild) {
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
  ctx.strokeStyle = card ? '#fff6db45' : '#d6bb8055'
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
  if (card) {
    ctx.shadowColor = '#00000025'
    ctx.shadowBlur = 10
    ctx.shadowOffsetY = 5
    ctx.font = `700 ${card.visual.symbol.length > 1 ? 128 : 180}px Arial, sans-serif`
    ctx.fillText(card.visual.symbol, 192, 282)
    ctx.shadowColor = 'transparent'
    ctx.font = '700 36px Arial, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(card.visual.symbol, 35, 57)
    ctx.font = '500 12px Arial, sans-serif'
    ctx.fillText(card.isWild ? 'ANY COLOR' : card.color.toUpperCase(), 36, 88)
    ctx.save()
    ctx.translate(349, 520)
    ctx.rotate(Math.PI)
    ctx.font = '700 36px Arial, sans-serif'
    ctx.fillText(card.visual.symbol, 0, 0)
    ctx.restore()
    ctx.textAlign = 'center'
    ctx.font = '600 16px Arial, sans-serif'
    ctx.fillText(card.visual.label.toUpperCase(), 192, 442)
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
export function cardImage(card?: Card) {
  const key = card ? `${card.color}-${card.value}` : 'back'
  if (!images.has(key)) images.set(key, cardArtwork(card).toDataURL())
  return images.get(key)!
}
