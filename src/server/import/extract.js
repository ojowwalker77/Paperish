// In-page DOM extractor for URL import. Evaluated inside the target page via
// Playwright, so it must be a single self-contained function expression with
// no imports. It walks the rendered DOM and returns a tree of design nodes with
// computed styles (only where they differ from what Paperish's renderer would
// produce anyway). Every emitted element is tagged data-pw-i=<index> in
// document order so the server can fetch authored sizing via CDP.
;(opts) => {
  const MAX = opts.maxNodes || 6000
  const RENDER = new Set(opts.renderTags || [])
  const INHERITED = [
    'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textAlign', 'textTransform', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap', 'textShadow',
    'fontVariantNumeric', 'fontFeatureSettings', 'fontVariationSettings', 'listStyleType', 'listStylePosition',
    'direction', 'hyphens', 'textWrap', 'WebkitTextStrokeWidth', 'WebkitTextStrokeColor', 'WebkitTextFillColor',
  ]
  const NON_INHERITED = [
    'display', 'position', 'zIndex', 'float', 'clear', 'boxSizing', 'verticalAlign',
    'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent', 'alignSelf', 'justifyItems',
    'justifySelf', 'order', 'flexGrow', 'flexShrink', 'rowGap', 'columnGap', 'gridAutoFlow', 'gridAutoColumns',
    'gridAutoRows', 'gridTemplateAreas', 'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'overflowX', 'overflowY', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
    'backgroundRepeat', 'backgroundClip', 'backgroundOrigin', 'boxShadow', 'opacity', 'transform',
    'transformOrigin', 'rotate', 'scale', 'translate', 'filter', 'backdropFilter', 'mixBlendMode', 'clipPath',
    'maskImage', 'objectFit', 'objectPosition', 'aspectRatio', 'textDecorationLine', 'textDecorationColor',
    'textDecorationStyle', 'textDecorationThickness', 'textUnderlineOffset', 'textOverflow', 'isolation',
    'WebkitLineClamp', 'WebkitBoxOrient', 'outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset',
    'visibility', 'pointerEvents', 'contain', 'columnCount', 'columnWidth',
  ]
  const SIZING = [
    'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'marginTop', 'marginRight',
    'marginBottom', 'marginLeft', 'top', 'right', 'bottom', 'left', 'flexBasis', 'gridTemplateColumns',
    'gridTemplateRows',
  ]
  const PHRASING = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'label', 'font', 'br', 'nobr'])
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'title', 'base', 'source', 'track', 'param', 'dialog'])
  const SEMANTIC = { header: 'Header', nav: 'Nav', main: 'Main', footer: 'Footer', section: 'Section', aside: 'Aside', article: 'Article', button: 'Button', form: 'Form', ul: 'List', ol: 'List', li: 'List Item', a: 'Link', figure: 'Figure', table: 'Table' }
  const SVG_PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'stop-color', 'stop-opacity']

  let count = 0
  let index = 0
  let truncated = false
  const families = new Set()
  const hoisted = []

  // Baseline: what our renderer (UA + Paperish reset) produces for a tag.
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;border:0;visibility:hidden'
  document.documentElement.appendChild(frame)
  const bdoc = frame.contentDocument
  bdoc.open()
  bdoc.write('<!doctype html><html><head><style>' + opts.resetCss + '</style></head><body><div id="p"></div></body></html>')
  bdoc.close()
  const bparent = bdoc.getElementById('p')
  const bwin = bdoc.defaultView
  const baseCache = new Map()
  const ALL = INHERITED.concat(NON_INHERITED)
  function baseline(tag) {
    let b = baseCache.get(tag)
    if (b) return b
    let el
    try {
      el = bdoc.createElement(tag)
    } catch {
      el = bdoc.createElement('div')
    }
    bparent.appendChild(el)
    const cs = bwin.getComputedStyle(el)
    const ps = bwin.getComputedStyle(bparent)
    b = { values: {}, uaInherited: new Set() }
    for (const p of ALL) b.values[p] = cs[p]
    for (const p of INHERITED) if (cs[p] !== ps[p]) b.uaInherited.add(p)
    el.remove()
    baseCache.set(tag, b)
    return b
  }

  function styleOf(cs, parentCS, tag) {
    const b = baseline(tag)
    const s = {}
    for (const p of NON_INHERITED) {
      const v = cs[p]
      if (v !== b.values[p] && v !== '') s[p] = v
    }
    for (const p of INHERITED) {
      const v = cs[p]
      if (v === '') continue
      if (!parentCS || v !== parentCS[p] || b.uaInherited.has(p)) s[p] = v
    }
    // These default to currentColor; a resolved copy would pin the colour and
    // silently override later edits to `color`.
    for (const p of ['WebkitTextFillColor', 'WebkitTextStrokeColor', 'textDecorationColor']) if (s[p] === cs.color || cs[p] === cs.color) delete s[p]
    if (s.fontFamily) for (const f of s.fontFamily.split(',')) families.add(f.trim().replace(/^["']|["']$/g, ''))
    return s
  }

  function sizing(cs) {
    const o = {}
    for (const p of SIZING) o[p] = cs[p]
    o._fs = cs.fontSize
    return o
  }

  function hasBox(cs) {
    return (
      cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
      cs.backgroundImage !== 'none' ||
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderRightWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth) > 0 ||
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingRight) + parseFloat(cs.paddingBottom) + parseFloat(cs.paddingLeft) > 0 ||
      cs.boxShadow !== 'none'
    )
  }

  function hasPseudo(el) {
    for (const w of ['::before', '::after']) {
      const c = getComputedStyle(el, w).content
      if (c && c !== 'none' && c !== 'normal') return true
    }
    return false
  }

  /** An inline element that only carries typography (flattened into its parent's text). */
  function isInlineText(el) {
    const tag = el.tagName.toLowerCase()
    if (!PHRASING.has(tag)) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return true
    if (cs.display !== 'inline' || hasBox(cs) || hasPseudo(el)) return false
    for (const c of el.children) if (!isInlineText(c)) return false
    return true
  }

  function collect(el, pre) {
    let out = ''
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += pre ? n.data : n.data.replace(/[\t\n\r\f ]+/g, ' ')
      else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase()
        if (tag === 'br') out += '\n'
        else if (getComputedStyle(n).display !== 'none') out += collect(n, pre)
      }
    }
    return out
  }

  function cleanText(s, pre) {
    if (pre) return s.replace(/^\n/, '').replace(/\n$/, '')
    return s
      .split('\n')
      .map((l) => l.replace(/ +/g, ' ').trim())
      .join('\n')
      .trim()
  }

  function nameOf(el, tag) {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.slice(0, 40)
    if (el.id && !/\d{3,}|^[a-z0-9_-]{12,}$/i.test(el.id)) return el.id.slice(0, 40)
    return SEMANTIC[tag] || null
  }

  function mark(el) {
    el.setAttribute('data-pw-i', String(index))
    return index++
  }

  function parseContentString(c) {
    const q = c[0]
    if (q !== '"' && q !== "'") return null
    try {
      return JSON.parse('"' + c.slice(1, -1).replace(/\\([0-9a-f]{1,6}) ?/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/"/g, '\\"') + '"')
    } catch {
      return c.slice(1, -1)
    }
  }

  function pseudo(el, cs, which) {
    const ps = getComputedStyle(el, which)
    const content = ps.content
    if (!content || content === 'none' || content === 'normal' || ps.display === 'none') return null
    const styles = styleOf(ps, cs, 'span')
    if (ps.display !== 'inline') {
      styles.width = ps.width
      styles.height = ps.height
    }
    if (ps.position === 'absolute' || ps.position === 'fixed') {
      styles.position = 'absolute'
      for (const k of ['top', 'right', 'bottom', 'left']) if (ps[k] !== 'auto') styles[k] = ps[k]
    }
    const url = content.match(/^url\(["']?(.*?)["']?\)$/)
    if (url) return { i: -1, tag: 'img', type: 'Image', src: url[1], styles, children: [] }
    const text = parseContentString(content)
    if (text === null) return null
    if (!text) return { i: -1, tag: 'span', type: 'Frame', styles, children: [], name: which === '::before' ? 'Before' : 'After' }
    return { i: -1, tag: 'span', type: 'Text', text, styles, children: [] }
  }

  function serializeSvg(svg, cs) {
    const clone = svg.cloneNode(true)
    const src = [svg, ...svg.querySelectorAll('*')]
    const dst = [clone, ...clone.querySelectorAll('*')]
    for (let i = 0; i < src.length; i++) {
      const s = src[i]
      const d = dst[i]
      if (!d) continue
      const scs = getComputedStyle(s)
      const pcs = i === 0 ? null : getComputedStyle(s.parentElement)
      for (const p of SVG_PAINT) {
        const v = scs.getPropertyValue(p)
        if (!v) continue
        if (i === 0 || !pcs || v !== pcs.getPropertyValue(p) || s.hasAttribute(p)) d.setAttribute(p, v)
      }
      if (scs.display === 'none') d.setAttribute('display', 'none')
      d.removeAttribute('class')
      d.removeAttribute('style')
      for (const a of [...d.attributes]) if (/^on/i.test(a.name) || a.name.startsWith('data-')) d.removeAttribute(a.name)
    }
    for (const u of [...clone.querySelectorAll('use')]) {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href')
      if (!href || href[0] !== '#') continue
      const ref = document.getElementById(href.slice(1))
      if (!ref) continue
      const isSymbol = ref.tagName.toLowerCase() === 'symbol'
      const g = document.createElementNS('http://www.w3.org/2000/svg', isSymbol ? 'svg' : 'g')
      if (isSymbol) {
        const vb = ref.getAttribute('viewBox')
        if (vb) g.setAttribute('viewBox', vb)
        g.setAttribute('width', u.getAttribute('width') || '100%')
        g.setAttribute('height', u.getAttribute('height') || '100%')
      }
      for (const a of ['x', 'y', 'transform', 'fill', 'stroke', 'stroke-width', 'opacity']) if (u.hasAttribute(a)) g.setAttribute(a, u.getAttribute(a))
      for (const c of ref.childNodes) g.appendChild(c.cloneNode(true))
      u.replaceWith(g)
    }
    const r = svg.getBoundingClientRect()
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(r.width * 100) / 100))
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(r.height * 100) / 100))
    clone.setAttribute('color', cs.color)
    clone.removeAttribute('data-pw-i')
    return new XMLSerializer().serializeToString(clone)
  }

  function placeholder(el, cs, parentCS, tag, label) {
    const node = { i: mark(el), tag: 'div', type: 'Frame', styles: styleOf(cs, parentCS, 'div'), sz: sizing(cs), fixedSize: true, children: [], name: nameOf(el, tag) || label }
    return node
  }

  function walk(el, parentCS) {
    if (count >= MAX) {
      truncated = true
      return null
    }
    const srcTag = el.tagName.toLowerCase()
    if (SKIP.has(srcTag) || el === frame || srcTag === 'br') return null
    // Render with a tag Paperish emits; take the UA baseline of that tag.
    const tag = RENDER.has(srcTag) || srcTag === 'svg' || srcTag === 'img' ? srcTag : baseline(srcTag).values.display === 'inline' ? 'span' : 'div'
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || (cs.visibility === 'hidden' && !el.querySelector('*'))) return null
    if (cs.display === 'contents') {
      // Children lay out in the parent; keep them by wrapping in nothing.
      const kids = []
      for (const c of el.children) {
        const n = walk(c, parentCS)
        if (n) kids.push(n)
      }
      return kids.length ? { contents: kids } : null
    }
    count++

    let node
    if (srcTag === 'svg') {
      node = { i: mark(el), tag: 'svg', type: 'SVG', svg: serializeSvg(el, cs), styles: styleOf(cs, parentCS, 'svg'), sz: sizing(cs), fixedSize: true, children: [], name: nameOf(el, tag) || 'SVG' }
    } else if (srcTag === 'img') {
      const src = el.currentSrc || el.src
      if (!src) return null
      node = { i: mark(el), tag: 'img', type: 'Image', src, alt: el.alt || '', styles: styleOf(cs, parentCS, 'img'), sz: sizing(cs), fixedSize: true, children: [], name: nameOf(el, tag) }
    } else if (srcTag === 'video') {
      node = el.poster
        ? { i: mark(el), tag: 'img', type: 'Image', src: el.poster, styles: styleOf(cs, parentCS, 'img'), sz: sizing(cs), fixedSize: true, children: [], name: 'Video' }
        : placeholder(el, cs, parentCS, tag, 'Video')
      if (!el.poster) node.styles.backgroundColor = '#000'
    } else if (srcTag === 'canvas') {
      let data = null
      try {
        data = el.toDataURL('image/png')
      } catch {}
      node = data
        ? { i: mark(el), tag: 'img', type: 'Image', src: data, styles: styleOf(cs, parentCS, 'img'), sz: sizing(cs), fixedSize: true, children: [], name: 'Canvas' }
        : placeholder(el, cs, parentCS, tag, 'Canvas')
    } else if (srcTag === 'iframe' || srcTag === 'embed' || srcTag === 'object') {
      node = placeholder(el, cs, parentCS, tag, 'Embed')
      node.styles.backgroundColor = node.styles.backgroundColor || '#E7E5E4'
    } else if (srcTag === 'input' || srcTag === 'textarea' || srcTag === 'select') {
      node = placeholder(el, cs, parentCS, srcTag, srcTag === 'select' ? 'Select' : 'Input')
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'hidden') return null
      if (type !== 'checkbox' && type !== 'radio') {
        const value = srcTag === 'select' ? el.options[el.selectedIndex]?.text || '' : el.value
        const text = value || el.placeholder || ''
        if (text) {
          const tstyles = {}
          if (!value && el.placeholder) tstyles.color = getComputedStyle(el, '::placeholder').color
          tstyles.whiteSpace = 'nowrap'
          node.children.push({ i: -1, tag: 'span', type: 'Text', text, styles: tstyles, children: [] })
          node.styles.display = 'flex'
          node.styles.alignItems = srcTag === 'textarea' ? 'flex-start' : 'center'
          node.styles.overflowX = 'hidden'
          node.styles.overflowY = 'hidden'
        }
      }
    } else {
      const pre = /^pre|break-spaces/.test(cs.whiteSpace)
      const kids = [...el.children].filter((c) => !SKIP.has(c.tagName.toLowerCase()) && getComputedStyle(c).display !== 'none')
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())
      const before = pseudo(el, cs, '::before')
      const after = pseudo(el, cs, '::after')
      const flexy = /flex|grid/.test(cs.display)
      const textOnly = hasText && !before && !after && (kids.length === 0 || (!flexy && kids.every(isInlineText)))
      if (textOnly) {
        node = { i: mark(el), tag, type: 'Text', text: cleanText(collect(el, pre), pre), styles: styleOf(cs, parentCS, tag), sz: sizing(cs), children: [], name: nameOf(el, srcTag) }
      } else {
        node = { i: mark(el), tag, type: 'Frame', styles: styleOf(cs, parentCS, tag), sz: sizing(cs), children: [], name: nameOf(el, srcTag) }
        if (before) node.children.push(before)
        for (const c of el.childNodes) {
          if (c.nodeType === 3) {
            const t = cleanText(pre ? c.data : c.data.replace(/[\t\n\r\f ]+/g, ' '), pre)
            if (t) node.children.push({ i: -1, tag: 'span', type: 'Text', text: t, styles: {}, children: [] })
          } else if (c.nodeType === 1) {
            const n = walk(c, cs)
            if (!n) continue
            if (n.contents) node.children.push(...n.contents)
            else node.children.push(n)
          }
        }
        if (after) node.children.push(after)
      }
    }

    if (srcTag === 'a' && el.href) node.href = el.href
    const role = el.getAttribute('role')
    if (role) node.role = role
    if ((srcTag === 'td' || srcTag === 'th') && (el.colSpan > 1 || el.rowSpan > 1)) {
      node.colSpan = el.colSpan > 1 ? el.colSpan : undefined
      node.rowSpan = el.rowSpan > 1 ? el.rowSpan : undefined
    }

    // Fixed elements are hoisted to the page root at their on-screen position.
    if (cs.position === 'fixed') {
      const r = el.getBoundingClientRect()
      node.styles.position = 'absolute'
      node.fixed = { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width }
      hoisted.push(node)
      return null
    }
    if (cs.position === 'sticky') {
      node.styles.position = 'relative'
      node.sticky = true
    }
    return node
  }

  // ---- run ------------------------------------------------------------------------
  const body = document.body
  const bodyCS = getComputedStyle(body)
  const htmlCS = getComputedStyle(document.documentElement)
  const root = { i: -1, tag: 'div', type: 'Frame', styles: {}, children: [], name: document.title || location.hostname }
  for (const c of body.childNodes) {
    if (c.nodeType === 3) {
      const t = c.data.replace(/\s+/g, ' ').trim()
      if (t) root.children.push({ i: -1, tag: 'span', type: 'Text', text: t, styles: {}, children: [] })
    } else if (c.nodeType === 1) {
      const n = walk(c, bodyCS)
      if (!n) continue
      if (n.contents) root.children.push(...n.contents)
      else root.children.push(n)
    }
  }
  root.children.push(...hoisted)

  const rootStyles = {}
  for (const p of INHERITED) rootStyles[p] = bodyCS[p]
  if (bodyCS.fontFamily) for (const f of bodyCS.fontFamily.split(',')) families.add(f.trim().replace(/^["']|["']$/g, ''))
  const bg = bodyCS.backgroundColor !== 'rgba(0, 0, 0, 0)' || bodyCS.backgroundImage !== 'none' ? bodyCS : htmlCS
  rootStyles.backgroundColor = bg.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#ffffff' : bg.backgroundColor
  if (bg.backgroundImage !== 'none') {
    rootStyles.backgroundImage = bg.backgroundImage
    rootStyles.backgroundSize = bg.backgroundSize
    rootStyles.backgroundPosition = bg.backgroundPosition
    rootStyles.backgroundRepeat = bg.backgroundRepeat
  }
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const m = parseFloat(bodyCS['margin' + side]) + parseFloat(bodyCS['padding' + side])
    if (m) rootStyles['padding' + side] = m + 'px'
  }
  rootStyles.display = bodyCS.display === 'flex' || bodyCS.display === 'grid' ? bodyCS.display : 'block'
  if (bodyCS.display === 'flex') {
    rootStyles.flexDirection = bodyCS.flexDirection
    rootStyles.alignItems = bodyCS.alignItems
  }

  frame.remove()
  return {
    title: document.title,
    url: location.href,
    width: window.innerWidth,
    height: Math.max(document.documentElement.scrollHeight, body.scrollHeight),
    rootFontSize: parseFloat(htmlCS.fontSize) || 16,
    rootStyles,
    root,
    count,
    marked: index,
    truncated,
    families: [...families],
  }
}
