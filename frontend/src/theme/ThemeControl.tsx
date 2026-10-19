import { useEffect, useId, useRef } from 'react'
import { Check, Feather, Monitor, Moon, Sparkles, Sun } from 'lucide-react'
import { useMotionPreference, useReducedMotion } from '../motion/preference'
import type { MotionPreference } from '../motion/preference'
import { viewTransition } from '../navigation'
import { useTheme } from './ThemeProvider'

type Appearance = 'system' | 'light' | 'dark'

/**
 * The new theme spreads out from the control that asked for it, as a circle
 * over the old one. Only when the page actually changes colour: "System" on a
 * light device, from Light, has nothing to reveal.
 */
function revealTheme(from: HTMLElement, apply: () => void) {
  const box = from.getBoundingClientRect(),
    x = box.left + box.width / 2,
    y = box.top + box.height / 2,
    radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  viewTransition('theme', apply)?.ready.then(() =>
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      {
        duration: 620,
        easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    ),
  )
}

export default function ThemeControl() {
  const { appearance, theme, setAppearance } = useTheme()
  const Icon = appearance === 'system' ? Monitor : appearance === 'light' ? Sun : Moon
  return (
    <div className="display-controls">
      <label className="theme-control" title="Appearance">
        <Icon size={16} aria-hidden="true" />
        <select
          className="theme-select"
          aria-label="Appearance"
          value={appearance}
          onChange={(event) => {
            const value = event.target.value
            if (value !== 'system' && value !== 'light' && value !== 'dark') return
            const next =
              value === 'system'
                ? matchMedia('(prefers-color-scheme: dark)').matches
                  ? 'dark'
                  : 'light'
                : value
            if (next === theme) setAppearance(value)
            else revealTheme(event.currentTarget, () => setAppearance(value as Appearance))
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <MotionControl />
    </div>
  )
}

const MOTION_OPTIONS: { value: MotionPreference; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follow this device' },
  { value: 'full', label: 'Full', hint: 'Every hop, roll and flourish' },
  { value: 'reduced', label: 'Reduced', hint: 'Shorter, softer moves' },
]

/**
 * The site-wide motion setting, beside Appearance in every header. A button
 * and a popover rather than a second select: headers are already tight on a
 * phone, and the options need a word of explanation each.
 */
function MotionControl() {
  const [preference, setPreference] = useMotionPreference()
  const reduced = useReducedMotion()
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const current = MOTION_OPTIONS.find((option) => option.value === preference)!
  const Icon = reduced ? Feather : Sparkles

  // Top layer, so no header can clip it; placed under the button as it opens.
  useEffect(() => {
    const popover = panel.current
    if (!popover) return
    const place = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open' || !button.current) return
      const box = button.current.getBoundingClientRect(),
        width = Math.min(260, innerWidth - 16)
      popover.style.width = `${width}px`
      popover.style.top = `${box.bottom + 8}px`
      popover.style.left = `${Math.max(8, Math.min(box.right - width, innerWidth - width - 8))}px`
    }
    popover.addEventListener('beforetoggle', place)
    return () => popover.removeEventListener('beforetoggle', place)
  }, [])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="motion-control"
        popoverTarget={`${id}-motion`}
        aria-label={`Motion: ${current.label}`}
        title={`Motion: ${current.label}${preference === 'system' ? (reduced ? ' (reduced)' : ' (full)') : ''}`}
      >
        <Icon key={String(reduced)} size={16} aria-hidden="true" className="motion-control-icon" />
      </button>
      <div ref={panel} id={`${id}-motion`} popover="auto" className="motion-popover">
        <fieldset>
          <legend>Motion</legend>
          {MOTION_OPTIONS.map((option) => (
            <label key={option.value} className="motion-option">
              <input
                type="radio"
                name={`${id}-motion-preference`}
                value={option.value}
                checked={preference === option.value}
                onChange={() => setPreference(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
              <Check size={15} aria-hidden="true" />
            </label>
          ))}
        </fieldset>
      </div>
    </>
  )
}
