import { createContext, useContext, useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { X } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'

const Close = createContext<() => void>(() => {})

/** A button that closes the dialog it sits in, letting it play its exit first. */
export function DialogDismiss(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const close = useContext(Close)
  return <button {...props} onClick={close} />
}

/**
 * A native modal: focus trapping and a backdrop for free, and `motion-dialog`
 * for its entrance. Closing it from inside plays the exit before React takes it
 * away; anything that replaces it outright simply removes it.
 */
export default function Dialog({
  title,
  children,
  onClose,
  locked = false,
  className = '',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  locked?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null),
    mounted = useRef(false),
    closing = useRef(false)
  useEffect(() => {
    const dialog = ref.current!
    mounted.current = true
    dialog.showModal()
    return () => {
      mounted.current = false
      dialog.close()
    }
  }, [])
  const close = () => {
    const dialog = ref.current
    if (!dialog || closing.current) return
    if (reducedMotion()) return onClose()
    closing.current = true
    dialog.close()
    // The exit runs on the closed element; unmount once it has, unless
    // something else has already replaced this dialog.
    setTimeout(() => mounted.current && onClose(), 260)
  }
  return (
    <dialog
      ref={ref}
      className={`pr-dialog motion-dialog ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!locked) close()
      }}
    >
      <Close.Provider value={close}>
        {!locked && (
          <button className="pr-icon pr-close" onClick={close} aria-label="Close dialog">
            <X size={19} />
          </button>
        )}
        {children}
      </Close.Provider>
    </dialog>
  )
}
