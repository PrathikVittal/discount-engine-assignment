/**
 * MessageBanner.tsx — shows adapter errors and notices.
 *
 * Skipped rows are a warning, not an error: the rest of the file still loaded,
 * and the user needs to know exactly which lines were dropped.
 */

interface Props {
  messages: string[]
  tone?: 'error' | 'warn' | 'info'
  title?: string
}

export default function MessageBanner({ messages, tone = 'error', title }: Props) {
  if (messages.length === 0) return null

  const heading =
    title ??
    (tone === 'warn'
      ? `${messages.length} row${messages.length > 1 ? 's' : ''} skipped`
      : `${messages.length} issue${messages.length > 1 ? 's' : ''} found`)

  return (
    <div className={`banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="banner-title">{heading}</div>
      {messages.length === 1 ? (
        <div>{messages[0]}</div>
      ) : (
        <ul>
          {messages.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
