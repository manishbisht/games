import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * A native modal that stays mounted while closed, so closing it can play the
 * shared `motion-dialog` exit instead of vanishing with the element.
 */
export default function Dialog({
  open,
  title,
  onClose,
  children,
  className = '',
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])
  useEffect(() => {
    const dialog = ref.current!
    return () => dialog.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`wr-dialog motion-dialog ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <button className="wr-icon-button wr-close" onClick={onClose} aria-label="Close dialog">
        <X size={20} />
      </button>
      {children}
    </dialog>
  )
}
