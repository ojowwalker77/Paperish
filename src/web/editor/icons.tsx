import type { NodeType } from '../../shared/types'

type P = { size?: number }

const svg = (size: number, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
)

export const Icon = {
  Frame: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />
      </>,
    ),
  Artboard: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      </>,
    ),
  Text: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="M3.5 4V3h9v1M8 3v10M6 13h4" />
      </>,
    ),
  Image: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <circle cx="6" cy="6" r="1.2" />
        <path d="m13.5 10.5-3-3-6 6" />
      </>,
    ),
  SVG: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="M3 13 8 3l5 10" />
        <path d="M5 9h6" />
      </>,
    ),
  Move: ({ size = 16 }: P) =>
    svg(
      size,
      <>
        <path d="m3.5 2.5 9 4-4 1.5-1.5 4z" />
      </>,
    ),
  Hand: ({ size = 16 }: P) =>
    svg(
      size,
      <>
        <path d="M5.5 8V4a1 1 0 0 1 2 0v3.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7V4a1 1 0 0 1 2 0v5c0 2.8-1.8 4.5-4 4.5-1.6 0-2.6-.7-3.5-2L2.8 9.4a1 1 0 0 1 1.6-1.1l1.1 1.2" />
      </>,
    ),
  Eye: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
      </>,
    ),
  EyeOff: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <path d="M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.3 4.4C2.5 5.6 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.5 3.4-1.1M7 3.6c.3-.1.7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2" />
      </>,
    ),
  Lock: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </>,
    ),
  Unlock: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />
      </>,
    ),
  Chevron: ({ size = 10 }: P) => svg(size, <path d="m6 4 4 4-4 4" />),
  Plus: ({ size = 14 }: P) => svg(size, <path d="M8 3v10M3 8h10" />),
  Undo: ({ size = 15 }: P) =>
    svg(
      size,
      <>
        <path d="M5.5 5.5H10a3.5 3.5 0 0 1 0 7H6" />
        <path d="M7.5 3 5 5.5 7.5 8" />
      </>,
    ),
  Redo: ({ size = 15 }: P) =>
    svg(
      size,
      <>
        <path d="M10.5 5.5H6a3.5 3.5 0 0 0 0 7h4" />
        <path d="M8.5 3 11 5.5 8.5 8" />
      </>,
    ),
  Search: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <circle cx="7" cy="7" r="4.25" />
        <path d="m10.2 10.2 3.3 3.3" />
      </>,
    ),
  Plug: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14" />
      </>,
    ),
  Copy: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
        <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
      </>,
    ),
  PanelLeft: ({ size = 16 }: P) =>
    svg(
      size,
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M6 2.5v11" />
      </>,
    ),
  PanelRight: ({ size = 16 }: P) =>
    svg(
      size,
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M10 2.5v11" />
      </>,
    ),
  Code: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" />
      </>,
    ),
  Component: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <path d="M8 1.8 10.2 4 8 6.2 5.8 4ZM8 9.8l2.2 2.2L8 14.2 5.8 12ZM4 5.8 6.2 8 4 10.2 1.8 8ZM12 5.8 14.2 8 12 10.2 9.8 8Z" />
      </>,
    ),
  Globe: ({ size = 15 }: P) =>
    svg(
      size,
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14c-1.7-1.8-2.5-3.8-2.5-6S6.3 3.8 8 2Z" />
      </>,
    ),
  Play: ({ size = 14 }: P) => svg(size, <path d="M5 3.5v9l7.5-4.5z" />),
  Close: ({ size = 16 }: P) => svg(size, <path d="m4 4 8 8M12 4l-8 8" />),
  Edit: ({ size = 15 }: P) =>
    svg(
      size,
      <>
        <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />
        <path d="m9 4 3 3" />
      </>,
    ),
  External: ({ size = 15 }: P) =>
    svg(
      size,
      <>
        <path d="M9 2.5h4.5V7" />
        <path d="M13.5 2.5 7.5 8.5" />
        <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
      </>,
    ),
  ChevronLeft: ({ size = 12 }: P) => svg(size, <path d="m10 4-4 4 4 4" />),
  Folder: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.6l1.5 1.5H12A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z" />
      </>,
    ),
  Trash: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
      </>,
    ),
  Branch: ({ size = 13 }: P) =>
    svg(
      size,
      <>
        <circle cx="5" cy="3.5" r="1.5" />
        <circle cx="5" cy="12.5" r="1.5" />
        <circle cx="11" cy="5.5" r="1.5" />
        <path d="M5 5v6M11 7c0 2.5-2 3-6 4" />
      </>,
    ),
  File: ({ size = 14 }: P) =>
    svg(
      size,
      <>
        <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z" />
        <path d="M9 2v4h4" />
      </>,
    ),
}

export function NodeIcon({ type, top }: { type: NodeType; top?: boolean }) {
  if (top && type === 'Frame') return <Icon.Artboard />

  if (type === 'Component')
    return (
      <span style={{ color: '#7c3aed', display: 'grid' }}>
        <Icon.Component />
      </span>
    )
  // SAFETY: NodeType callers pass Frame/Text/Image/SVG here; Root falls back to Frame.
  const C = Icon[type as 'Frame' | 'Text' | 'Image' | 'SVG'] ?? Icon.Frame

  return <C />
}
