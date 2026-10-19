import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'

/**
 * A native dialog that rises in and fades out (`motion-dialog`). Pass `open`
 * rather than mounting it conditionally and it stays mounted, showing what it
 * last showed, until its exit has played.
 */
export default function Modal({
  title,
  children,
  onClose,
  open = true,
  locked = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  open?: boolean
  locked?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [mounted, setMounted] = useState(open),
    [kept, setKept] = useState(children)
  if (open && !mounted) setMounted(true)
  if (open && children !== kept) setKept(children)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) dialog.showModal()
      return
    }
    dialog.close()
    const timer = setTimeout(() => setMounted(false), reducedMotion() ? 0 : 320)
    return () => clearTimeout(timer)
  }, [open, mounted])
  useEffect(() => {
    const dialog = ref.current
    return () => dialog?.close()
  }, [mounted])
  if (!mounted) return null
  return (
    <dialog
      ref={ref}
      className="ch-dialog motion-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        if (!locked) onClose()
      }}
    >
      {!locked && (
        <button className="ch-icon-button ch-dialog-close" aria-label="Close dialog" onClick={onClose}>
          <X size={19} />
        </button>
      )}
      {open ? children : kept}
    </dialog>
  )
}
