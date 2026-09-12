import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function Dialog({
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
      className="pr-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!locked) onClose()
      }}
    >
      {!locked && (
        <button className="pr-icon pr-close" onClick={onClose} aria-label="Close dialog">
          <X size={19} />
        </button>
      )}
      {children}
    </dialog>
  )
}
