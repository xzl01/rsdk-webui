import React, { createContext, useContext, useId } from 'react'

const FieldContext = createContext<{ id: string; descId?: string } | null>(null)

export function Card({
  title,
  hint,
  actions,
  children,
}: {
  title?: React.ReactNode
  hint?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header>
          {title && <h3>{title}</h3>}
          {hint && <span className="hint">{hint}</span>}
          <div className="spacer" />
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({
  label,
  desc,
  children,
  displayOnly = false,
}: {
  label?: React.ReactNode
  desc?: React.ReactNode
  children: React.ReactNode
  displayOnly?: boolean
}) {
  const id = useId()
  const descId = desc ? `${id}-desc` : undefined
  const control = React.isValidElement<React.TextareaHTMLAttributes<HTMLTextAreaElement>>(children) && children.type === 'textarea'
    ? React.cloneElement(children, { id, 'aria-describedby': descId })
    : children
  return (
    <FieldContext.Provider value={{ id, descId }}>
      <div className="field">
        {label && (displayOnly ? <span className="field-label">{label}</span> : <label htmlFor={id}>{label}</label>)}
        {control}
        {desc && <p className="desc" id={descId}>{desc}</p>}
      </div>
    </FieldContext.Provider>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}) {
  const field = useContext(FieldContext)
  return (
    <input
      id={field?.id}
      aria-describedby={field?.descId}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={mono ? { fontFamily: 'var(--mono)', fontSize: 12.5 } : undefined}
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ label: string; value: T }>
}) {
  const field = useContext(FieldContext)
  return (
    <select id={field?.id} aria-describedby={field?.descId} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  title,
  desc,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: React.ReactNode
  desc?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`toggle${checked ? ' on' : ''}`} style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="box">{checked ? '✓' : ''}</span>
      <span className="text">
        <strong>{title}</strong>
        {desc && <span>{desc}</span>}
      </span>
    </label>
  )
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  size,
  title,
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  size?: 'sm'
  title?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      title={title}
      className={`btn ${variant === 'default' ? '' : variant} ${size === 'sm' ? 'sm' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Chip({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: 'accent' | 'warn' | 'danger' | 'info'
}) {
  return <span className={`chip${tone ? ' ' + tone : ''}`}>{children}</span>
}

export function Note({
  tone,
  children,
}: {
  tone: 'warn' | 'danger' | 'info' | 'ok'
  children: React.ReactNode
}) {
  const icon = { warn: '⚠', danger: '✕', info: 'ℹ', ok: '✓' }[tone]
  return (
    <div className={`note ${tone}`}>
      <span aria-hidden>{icon}</span>
      <div>{children}</div>
    </div>
  )
}

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    queued: '排队中',
    running: '运行中',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
  }
  return (
    <span className={`status ${status}`}>
      <span className="led" />
      {label[status] ?? status}
    </span>
  )
}

export function TokenList({
  values,
  onRemove,
  empty,
}: {
  values: string[]
  onRemove: (v: string) => void
  empty?: string
}) {
  if (values.length === 0) return <span className="faint" style={{ fontSize: 12 }}>{empty ?? '—'}</span>
  return (
    <div className="chips">
      {values.map((v) => (
        <span className="token" key={v}>
          {v}
          <button type="button" onClick={() => onRemove(v)} title={`移除 ${v}`} aria-label={`移除 ${v}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

export function bytes(n: number | undefined): string {
  if (!n) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function ago(ts: number | undefined): string {
  if (!ts) return '—'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.round(s)} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

export function duration(from?: number, to?: number): string {
  if (!from) return '—'
  const ms = (to ?? Date.now()) - from
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
