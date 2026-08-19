/**
 * FileDropzone.tsx — click-or-drop file input.
 *
 * Hands the raw `File` to its parent and stops there. It doesn't know whether
 * the file is a CSV or a PDF; choosing the adapter is the parent's job, which is
 * what lets a new file type be supported without touching this component.
 */

import { useRef, useState, type DragEvent } from 'react'

interface Props {
  label: string
  description: string
  /** e.g. ".csv" or ".csv,.pdf" */
  accept: string
  onFile: (file: File) => void
  loadedName?: string
  busy?: boolean
}

export default function FileDropzone({
  label,
  description,
  accept,
  onFile,
  loadedName,
  busy = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const acceptedExtensions = accept.split(',').map((ext) => ext.trim().toLowerCase())
  const isAccepted = (file: File) =>
    acceptedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file && isAccepted(file)) onFile(file)
  }

  return (
    <button
      type="button"
      className={`dropzone${loadedName ? ' has-data' : ''}${dragging ? ' is-dragging' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      aria-label={`${label} — ${description}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          // Reset so re-picking the same file still fires a change event.
          event.target.value = ''
        }}
      />
      <span className="dropzone-icon">{busy ? '⏳' : loadedName ? '✅' : '📄'}</span>
      <span>
        <span className="dropzone-label">{label}</span>
        <span className="dropzone-desc">
          {busy ? 'Reading…' : (loadedName ?? description)}
        </span>
      </span>
      <span className="dropzone-action">{loadedName ? 'Change' : 'Upload'}</span>
    </button>
  )
}
