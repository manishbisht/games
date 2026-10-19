import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'

/**
 * A native dialog that rises in and fades out again: closing plays the exit
 * (`motion-dialog`) before the parent is told to unmount it. Buttons inside
 * mark themselves `data-close` to close the same way.
 */
export default function Modal({
  title,
  children,
  onClose,
  className = '',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null),
    closing = useRef(0)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => {
      clearTimeout(closing.current)
      dialog.close()
    }
  }, [])
  const close = () => {
    const dialog = ref.current
    if (!dialog?.open) return
    dialog.close()
    closing.current = window.setTimeout(onClose, reducedMotion() ? 0 : 260)
  }
  return (
    <dialog
      ref={ref}
      className={`hh-dialog motion-dialog ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onClick={(e) => {
        // Any button marked `data-close` dismisses with the exit, like the close button.
        if (e.target instanceof Element && e.target.closest('[data-close]')) close()
        else if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect()
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close()
        }
      }}
    >
      <button className="hh-icon-button hh-dialog-close" aria-label="Close dialog" onClick={close}>
        <X size={19} />
      </button>
      {children}
    </dialog>
  )
}
