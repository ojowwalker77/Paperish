// A text field that edits a name in place: Enter or blur commits, Esc cancels.

export function InlineInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  return (
    <input
      className="pw-inline-input"
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()

        if (e.key === 'Escape') {
          e.currentTarget.value = value
          e.currentTarget.blur()
        }

        e.stopPropagation()
      }}
    />
  )
}
