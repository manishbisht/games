import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { disposeObject, makePiece } from '../scene/models'
import type { Color, Preferences, PromotionPiece } from '@games/shared/chess/types'
import { PIECE_NAMES } from '@games/shared/chess/types'

const choices: PromotionPiece[] = ['q', 'r', 'b', 'n']
export default function PromotionGallery({
  color,
  theme,
  onChoose,
}: {
  color: Color
  theme: Preferences['theme']
  onChoose: (piece: PromotionPiece) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = ref.current!
    let renderer: THREE.WebGLRenderer | undefined,
      env: THREE.WebGLRenderTarget | undefined,
      observer: ResizeObserver | undefined
    const scene = new THREE.Scene()
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(1, 150)
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      const camera = new THREE.OrthographicCamera(-2.35, 2.35, 1, -1, 0.1, 30)
      camera.position.set(0, 3.3, 8)
      camera.lookAt(0, 0.65, 0)
      const room = new RoomEnvironment(),
        pmrem = new THREE.PMREMGenerator(renderer)
      env = pmrem.fromScene(room, 0.04)
      scene.environment = env.texture
      room.dispose()
      pmrem.dispose()
      scene.environmentIntensity = 0.4
      scene.add(new THREE.HemisphereLight('#fff8e5', '#777264', 1.4))
      const light = new THREE.DirectionalLight('#fff4dc', 2.25)
      light.position.set(-3, 5, 5)
      scene.add(light)
      choices.forEach((type, i) => {
        const p = makePiece(type, color, theme)
        p.position.x = (i - 1.5) * 1.15
        scene.add(p)
      })
      container.appendChild(renderer.domElement)
      // Child effects run before the dialog opens. Resize after it becomes visible.
      const resize = () => {
        const width = container.clientWidth
        if (!width || !renderer) return
        renderer.setSize(width, 150)
        camera.top = 2.35 / (width / 150)
        camera.bottom = -camera.top
        camera.updateProjectionMatrix()
        renderer.render(scene, camera)
      }
      observer = new ResizeObserver(resize)
      observer.observe(container)
      resize()
    } catch {
      container.classList.add('ch-preview-unavailable')
    }
    return () => {
      observer?.disconnect()
      disposeObject(scene)
      env?.dispose()
      renderer?.dispose()
      renderer?.domElement.remove()
    }
  }, [color, theme])
  return (
    <div className="ch-promotion-choices">
      <div ref={ref} className="ch-promotion-preview" aria-hidden="true" />
      <div className="ch-promotion-buttons">
        {choices.map((p) => (
          <button key={p} onClick={() => onChoose(p)}>
            {PIECE_NAMES[p]}
          </button>
        ))}
      </div>
    </div>
  )
}
