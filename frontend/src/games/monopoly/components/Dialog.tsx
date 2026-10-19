import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'

/** How long `motion-dialog`'s exit takes (`--motion-base`). */
const EXIT_MS = 260

/**
 * A native modal dialog that rises in and, when the person closes it — the ×,
 * Escape, or a click outside — fades back out before `onClose` unmounts it.
 * A dialog the page takes away itself (a card read at another seat, a settled
 * offer) just goes.
 */
export default function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  className = '',
}: {
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null),
    leaving = useRef<ReturnType<typeof setTimeout> | null>(null),
    titleId = useId()
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => {
      if (leaving.current) clearTimeout(leaving.current)
      dialog.close()
    }
  }, [])
  function close() {
    const dialog = ref.current
    if (leaving.current || !dialog) return
    if (reducedMotion()) return onClose()
    dialog.close()
    leaving.current = setTimeout(onClose, EXIT_MS)
  }
  return (
    <dialog
      ref={ref}
      className={`dialog motion-dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape would close the native dialog behind React's back; close it our way instead.
        e.preventDefault()
        close()
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect()
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close()
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
