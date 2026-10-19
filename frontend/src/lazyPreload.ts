import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'

export interface PreloadableComponent<P> {
  Component: LazyExoticComponent<ComponentType<P>>
  /**
   * Fetch the chunk now — on hover, on focus, while a room is being made. Safe
   * to call often, never rejects: it resolves to whether the chunk arrived.
   */
  preload: () => Promise<boolean>
}

/**
 * `React.lazy` that can be warmed before it renders, and renders synchronously
 * once warm.
 *
 * Plain `lazy` suspends on its first render even when the chunk is already in
 * the module cache, because it only learns that from a `.then` a microtask
 * later. Inside a view transition (which commits with `flushSync`) that brief
 * suspension is enough to photograph the loading skeleton instead of the game.
 * Handing `lazy` a thenable that resolves on the spot avoids it.
 *
 * A failed fetch is forgotten, so the next attempt retries rather than
 * replaying the rejection; the render still rejects, which is what
 * ChunkErrorBoundary is there to catch.
 */
export function lazyWithPreload<P>(
  load: () => Promise<{ default: ComponentType<P> }>,
): PreloadableComponent<P> {
  let loaded: { default: ComponentType<P> } | undefined
  let pending: Promise<{ default: ComponentType<P> }> | undefined
  const fetchModule = () =>
    (pending ??= load().then(
      (module) => (loaded = module),
      (error: unknown) => {
        pending = undefined
        throw error
      },
    ))
  const Component = lazy(() =>
    loaded
      ? ({ then: (resolve: (module: { default: ComponentType<P> }) => void) => resolve(loaded!) } as Promise<{
          default: ComponentType<P>
        }>)
      : fetchModule(),
  )
  const preload = () =>
    fetchModule().then(
      () => true,
      () => false,
    )
  return { Component, preload }
}
