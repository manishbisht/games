import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { COURTS } from '@games/shared/hearth/board'
import type { PlayerId } from '@games/shared/hearth/types'
import { createCameraRig } from '../../../motion/camera'
import { reducedMotion } from '../../../motion/preference'
import { allowPageScroll } from '../../../motion/stage'
import type { Stage } from '../../../motion/stage'

const HOME_VIEW = new THREE.Vector3(10, 18, 17),
  ORIGIN = new THREE.Vector3(),
  /** The default view as an angle round the centre, which every swing returns to. */
  HOME_ANGLE = new THREE.Spherical().setFromVector3(HOME_VIEW),
  /** Straight down, but for the sliver of tilt that keeps "up" on the screen pointing north. */
  TOP_POLAR = 0.03,
  /** How far a turn change swings the camera towards the court that is up, in radians. */
  COURT_SWING = 0.24

/**
 * The camera and whoever is directing it. The viewer can orbit and zoom; the
 * board swings round towards the court that is up, punches in on a capture
 * and frames the winner — and once the viewer has framed the table
 * themselves, turn changes stop moving it until they ask for the default
 * view back.
 */
export function createDirector(stage: Stage) {
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 100)
  camera.position.copy(HOME_VIEW)
  camera.lookAt(ORIGIN)
  stage.setCamera(camera)
  stage.onResize((width, height) => {
    const aspect = width / height,
      vertical = Math.max(14.7, 19.1 / aspect)
    camera.left = (-vertical * aspect) / 2
    camera.right = (vertical * aspect) / 2
    camera.top = vertical / 2
    camera.bottom = -vertical / 2
    camera.updateProjectionMatrix()
  })
  const controls = new OrbitControls(camera, stage.canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  controls.enablePan = false
  controls.minPolarAngle = TOP_POLAR
  controls.maxPolarAngle = Math.PI / 2.7
  controls.minZoom = 0.75
  controls.maxZoom = 1.8
  controls.rotateSpeed = 0.45
  controls.zoomSpeed = 0.65
  allowPageScroll(stage.canvas)
  const rig = createCameraRig(camera, controls)
  let framedByViewer = false
  const onViewer = () => {
    framedByViewer = true
  }
  controls.addEventListener('start', onViewer)
  controls.addEventListener('change', stage.invalidate)

  /** Swing round the board to `azimuth` (and the rest), or cut there under reduced motion. */
  function swing(
    azimuth: number,
    ms: number,
    rest: { polar?: number; target?: THREE.Vector3; zoom?: number },
  ) {
    rig.orbit({
      azimuth,
      polar: rest.polar ?? HOME_ANGLE.phi,
      radius: HOME_ANGLE.radius,
      target: rest.target ?? ORIGIN,
      zoom: rest.zoom,
      ms: reducedMotion() ? 120 : ms,
    })
    stage.invalidate()
  }

  return {
    camera,
    controls,
    rig,
    /**
     * Turn the table a little towards `player`'s court: an arc round the
     * centre, so the board turns under the viewer rather than sliding past.
     */
    handOver(player: PlayerId) {
      if (framedByViewer || rig.userControlled || reducedMotion()) return
      const [cx, cz] = COURTS[player]
      let turn = Math.atan2(cx, cz) - HOME_ANGLE.theta
      turn = Math.atan2(Math.sin(turn), Math.cos(turn))
      swing(HOME_ANGLE.theta + THREE.MathUtils.clamp(turn, -COURT_SWING, COURT_SWING), 1400, {
        target: new THREE.Vector3(cx * 0.12, 0, cz * 0.12),
      })
    },
    /** A quick punch in on a capture, easing back out once it has landed. */
    punch(at: (delay: number, effect: () => void) => void) {
      rig.shake(0.1, 260)
      if (rig.userControlled) return
      const zoom = camera.zoom
      rig.to({ zoom: Math.min(controls.maxZoom, zoom * 1.08) }, 16)
      at(260, () => rig.to({ zoom }, 3.5))
    },
    /** Back round to the default angle, a little closer in, to watch the winners. */
    celebrate() {
      if (rig.userControlled) return
      swing(HOME_ANGLE.theta, 1600, { target: new THREE.Vector3(0, 0.4, 0), zoom: 1.32 })
    },
    reset() {
      framedByViewer = false
      swing(HOME_ANGLE.theta, 900, { zoom: 1 })
    },
    top() {
      framedByViewer = true
      // Straight down, rising over the board rather than cutting through it.
      swing(0, 900, { polar: TOP_POLAR, zoom: 1 })
    },
    zoom(direction: number) {
      rig.to(
        { zoom: THREE.MathUtils.clamp(camera.zoom + direction * 0.15, controls.minZoom, controls.maxZoom) },
        reducedMotion() ? 30 : 6,
      )
      stage.invalidate()
    },
    step(dt: number) {
      const moving = controls.update()
      return rig.step(dt) || moving
    },
    dispose() {
      controls.removeEventListener('start', onViewer)
      controls.removeEventListener('change', stage.invalidate)
      rig.dispose()
      controls.dispose()
    },
  }
}
export type Director = ReturnType<typeof createDirector>
