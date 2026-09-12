import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function Modal({
  title,
  children,
  onClose,
  locked = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  locked?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="ch-dialog"
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
      {children}
    </dialog>
  )
}
