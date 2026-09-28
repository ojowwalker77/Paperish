import { stylesToCss } from './styles'
import type { PNode, Styles } from './types'

// Node tree -> static HTML with inline styles. Used for PDF/SVG export on the
// server and for copy-to-clipboard in the editor.

type Nodes = Record<string, PNode>

const CANVAS_ONLY = ['position', 'left', 'top']

/** Styles as exported: artboard canvas positioning is dropped. */
export function exportStyles(nodes: Nodes, n: PNode, isRoot: boolean): Styles {
  const s = { ...n.styles }
  const parent = n.parent ? nodes[n.parent] : null
  if (isRoot && parent?.type === 'Root') for (const k of CANVAS_ONLY) delete s[k]
  if (parent?.type === 'Root' && !('overflow' in s)) s.overflow = 'hidden'
  if (n.type === 'Text' && n.text?.includes('\n') && !('whiteSpace' in s)) s.whiteSpace = 'pre-wrap'
  return s
}

/**
 * `componentMarkup`: emit component instances as their JSX-like tags (for the
 * clipboard, so pasting into a file with the codebase linked recreates them);
 * otherwise as placeholders (static exports can't run code).
 */
export function toStaticHTML(nodes: Nodes, id: string, rootSize?: { width: number; height: number }, opts: { componentMarkup?: boolean } = {}): string {
  const emit = (n: PNode, isRoot: boolean): string => {
    const styles = exportStyles(nodes, n, isRoot)
    if (isRoot && rootSize) {
      styles.width = `${rootSize.width}px`
      styles.height = `${rootSize.height}px`
      styles.flexShrink = '0'
      delete styles.position
      delete styles.left
      delete styles.top
    }
    const style = Object.keys(styles).length ? ` style="${esc(stylesToCss(styles))}"` : ''
    const attrs = Object.entries(n.attrs ?? {})
      .map(([k, v]) => ` ${k}="${esc(v)}"`)
      .join('')
    if (n.type === 'SVG') return (n.svg ?? '<svg/>').replace(/^<svg\b/, `<svg${style}`)
    if (n.type === 'Component') {
      const name = n.component?.name ?? 'Component'
      if (!opts.componentMarkup) return `<div${style} data-component="${esc(name)}">${escText(name)}</div>`
      const props = Object.entries(n.props ?? {})
        .map(([k, v]) => (v === true ? ` ${k}` : typeof v === 'string' ? ` ${k}="${esc(v)}"` : ` ${k}={${esc(JSON.stringify(v))}}`))
        .join('')
      return n.content ? `<${name}${style}${props}>${n.content}</${name}>` : `<${name}${style}${props} />`
    }
    if (n.type === 'Image') return `<img src="${esc(n.src ?? '')}"${attrs}${style}>`
    const tag = n.tag || 'div'
    if (n.type === 'Text') return `<${tag}${attrs}${style}>${escText(n.text ?? '')}</${tag}>`
    const kids = n.children.map((c) => nodes[c]).filter((c): c is PNode => !!c && !c.hidden)
    return `<${tag}${attrs}${style}>${kids.map((k) => emit(k, false)).join('')}</${tag}>`
  }
  const root = nodes[id]
  if (!root) throw new Error(`Node "${id}" does not exist`)
  return emit(root, true)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
