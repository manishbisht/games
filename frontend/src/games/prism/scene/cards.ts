import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { Card } from '@games/shared/prism/types'
import { dampFactor, spring, stepSpring } from '../../../motion/ease'
import type { Spring } from '../../../motion/ease'
import { artKey, cardArtwork, everyFace, warm } from './artwork'

export const CARD_W = 1.36,
  CARD_H = 2.04

/** Where a card is, which way it faces and how big it is. */
export interface Pose {
  p: THREE.Vector3
  q: THREE.Quaternion
  s: number
}
export const pose = (): Pose => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1 })
export function copyPose(out: Pose, from: Pose) {
  out.p.copy(from.p)
  out.q.copy(from.q)
  out.s = from.s
  return out
}

/**
 * One card on the table. It eases from `current` toward `home` every frame,
 * so a fan that gains a card spreads and a pile that loses one settles rather
 * than snapping; a flight drives `current` directly while `flying`. `wobble`
 * is an underdamped spring for the jolt a card gets when another lands on it.
 */
export interface CardObject {
  group: THREE.Group
  front: THREE.Mesh
  home: Pose
  current: Pose
  wobble: Spring
  flying: boolean
}

const Y = new THREE.Vector3(0, 1, 0)
/** Turns a face-up pose face-down (and back), about the card's long axis. */
export const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)

/**
 * Every card object the table will ever show, pooled: the table never builds a
 * card per update, it borrows one and hands it back. Faces are one material
 * per artwork, painted and uploaded in idle time before they are needed.
 */
export function createCards(renderer: THREE.WebGLRenderer, parent: THREE.Object3D) {
  const body = new RoundedBoxGeometry(CARD_W, 0.044, CARD_H, 3, 0.065),
    plane = new THREE.PlaneGeometry(CARD_W, CARD_H),
    edge = new THREE.MeshStandardMaterial({ color: '#efeadb', roughness: 0.72 }),
    materials = new Map<string, THREE.MeshStandardMaterial>(),
    anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())

  function material(card?: Card) {
    const key = artKey(card)
    let found = materials.get(key)
    if (!found) {
      const texture = new THREE.CanvasTexture(cardArtwork(card))
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = anisotropy
      // Cut-out corners rather than blended ones: a stack of blended cards
      // re-sorts every frame and flickers as cards cross over each other.
      found = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.5,
        metalness: 0.02,
        alphaTest: 0.5,
      })
      materials.set(key, found)
    }
    return found
  }
  const back = material()

  const free: CardObject[] = []
  function build(): CardObject {
    const group = new THREE.Group()
    const shell = new THREE.Mesh(body, edge)
    shell.castShadow = true
    shell.receiveShadow = true
    const front = new THREE.Mesh(plane, back)
    front.rotation.x = -Math.PI / 2
    front.position.y = 0.0225
    front.receiveShadow = true
    const reverse = new THREE.Mesh(plane, back)
    reverse.rotation.x = Math.PI / 2
    reverse.position.y = -0.0225
    group.add(shell, front, reverse)
    return { group, front, home: pose(), current: pose(), wobble: spring(), flying: false }
  }

  const twist = new THREE.Quaternion()
  const cards = {
    /** A card showing `card` on its face (the back when it is hidden), placed at `at`. */
    acquire(card?: Card, at?: Pose) {
      const object = free.pop() ?? build()
      object.front.material = material(card)
      object.flying = false
      object.wobble.value = object.wobble.velocity = 0
      if (at) {
        copyPose(object.current, at)
        copyPose(object.home, at)
      }
      cards.place(object)
      parent.add(object.group)
      return object
    },
    release(object: CardObject) {
      object.group.removeFromParent()
      object.flying = false
      free.push(object)
    },
    face(object: CardObject, card?: Card) {
      object.front.material = material(card)
    },
    /** Writes `current` (plus any wobble) to the object. */
    place(object: CardObject) {
      const { group, current, wobble } = object
      group.position.copy(current.p)
      group.quaternion.copy(current.q)
      if (wobble.value) {
        group.position.y += Math.abs(wobble.value) * 0.05
        group.quaternion.multiply(twist.setFromAxisAngle(Y, wobble.value * 0.13))
      }
      group.scale.setScalar(current.s)
    },
    /** Eases a resting card toward home; returns whether it is still moving. */
    settle(object: CardObject, dt: number) {
      if (object.flying) return false
      const { current, home, wobble } = object
      let moving = false
      if (
        current.p.distanceToSquared(home.p) > 1e-7 ||
        Math.abs(current.s - home.s) > 1e-4 ||
        1 - Math.abs(current.q.dot(home.q)) > 1e-7
      ) {
        const k = dampFactor(13, dt)
        current.p.lerp(home.p, k)
        current.q.slerp(home.q, k)
        current.s += (home.s - current.s) * k
        moving = true
      } else copyPose(current, home)
      if (wobble.value || wobble.velocity) moving = stepSpring(wobble, 320, dt, 7) || moving
      cards.place(object)
      return moving
    },
    /** Paints and uploads every face while the browser is idle. Returns a cancel. */
    warm() {
      return warm(everyFace(), (card) => renderer.initTexture(material(card).map!))
    },
    dispose() {
      body.dispose()
      plane.dispose()
      edge.dispose()
      for (const found of materials.values()) {
        found.map?.dispose()
        found.dispose()
      }
    },
  }
  return cards
}
export type Cards = ReturnType<typeof createCards>
