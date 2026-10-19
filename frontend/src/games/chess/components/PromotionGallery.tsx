import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { clamp01, outBack, spring, stepSpring } from '../../../motion/ease'
import { reducedMotion } from '../../../motion/preference'
import { createStage } from '../../../motion/stage'
import { makePiece } from '../scene/models'
import type { Color, Preferences, PromotionPiece } from '@games/shared/chess/types'
import { PIECE_NAMES } from '@games/shared/chess/types'

const choices: PromotionPiece[] = ['q', 'r', 'b', 'n']

/**
 * The four candidates on a slow turntable. Each rises into view in turn, and
 * the one under the pointer (or keyboard focus) lifts and turns faster.
 */
export default function PromotionGallery({
  color,
  theme,
  onChoose,
}: {
  color: Color
  theme: Preferences['theme']
  onChoose: (piece: PromotionPiece) => void
}) {
  const ref = useRef<HTMLDivElement>(null),
    hover = useRef<(index: number | null) => void>(() => {})
  useEffect(() => {
    const container = ref.current!
    let stage: ReturnType<typeof createStage>
    try {
      stage = createStage(container, {
        maxPixelRatio: 2,
        exposure: 1,
        environmentIntensity: 0.4,
        shadows: false,
      })
    } catch {
      container.classList.add('ch-preview-unavailable')
      return
    }
    const { scene } = stage,
      camera = new THREE.OrthographicCamera(-2.35, 2.35, 1, -1, 0.1, 30)
    camera.position.set(0, 3.3, 8)
    camera.lookAt(0, 0.65, 0)
    stage.setCamera(camera)
    scene.add(new THREE.HemisphereLight('#fff8e5', '#777264', 1.4))
    const light = new THREE.DirectionalLight('#fff4dc', 2.25)
    light.position.set(-3, 5, 5)
    scene.add(light)
    const pieces = choices.map((type, i) => {
      const turntable = new THREE.Group()
      turntable.add(makePiece(type, color, theme))
      turntable.position.x = (i - 1.5) * 1.15
      turntable.rotation.y = i * 0.6
      turntable.scale.setScalar(0.001)
      scene.add(turntable)
      return { turntable, lift: spring(0), shown: -i * 0.09 }
    })
    let hovered: number | null = null
    hover.current = (index) => {
      hovered = index
      stage.invalidate()
    }
    // Child effects run before the dialog opens; the stage sizes itself once it is visible.
    stage.onResize((width, height) => {
      camera.top = 2.35 / (width / height)
      camera.bottom = -camera.top
      camera.updateProjectionMatrix()
    })
    stage.onFrame((dt) => {
      const reduced = reducedMotion()
      let moving = false
      pieces.forEach(({ turntable, lift, shown }, i) => {
        const appear = (pieces[i].shown = Math.min(1, shown + dt / (reduced ? 0.12 : 0.5)))
        if (appear < 1) moving = true
        turntable.scale.setScalar(Math.max(0.001, reduced ? clamp01(appear) : outBack(2)(clamp01(appear))))
        lift.target = hovered === i && !reduced ? 0.2 : 0
        if (stepSpring(lift, 160, dt, 2 * Math.sqrt(160) * 0.55)) moving = true
        turntable.position.y = lift.value
        if (!reduced) {
          turntable.rotation.y += dt * (hovered === i ? 1.9 : 0.42)
          moving = true
        }
      })
      return moving
    })
    stage.start()
    return () => {
      hover.current = () => {}
      stage.dispose()
    }
  }, [color, theme])
  return (
    <div className="ch-promotion-choices">
      <div ref={ref} className="ch-promotion-preview" aria-hidden="true" />
      <div className="ch-promotion-buttons">
        {choices.map((p, i) => (
          <button
            key={p}
            onClick={() => onChoose(p)}
            onPointerEnter={() => hover.current(i)}
            onPointerLeave={() => hover.current(null)}
            onFocus={() => hover.current(i)}
            onBlur={() => hover.current(null)}
          >
            {PIECE_NAMES[p]}
          </button>
        ))}
      </div>
    </div>
  )
}
