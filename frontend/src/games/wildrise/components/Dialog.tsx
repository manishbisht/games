import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function Dialog({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
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
      className={`wr-dialog ${className}`}
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
