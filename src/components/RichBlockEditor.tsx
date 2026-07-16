import { useEffect, useMemo, useRef, useState } from 'react'
import { Bold, CheckSquare, Code2, Command, GripVertical, Highlighter, Info, Italic, Link, List, ListOrdered, Minus, Quote, Strikethrough, Trash2, Underline } from 'lucide-react'

type BlockKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'bullet' | 'numbered' | 'todo' | 'quote' | 'info' | 'code' | 'divider'
type RichBlock = { id: string; kind: BlockKind; html: string; checked?: boolean }

const blockOptions: Array<{ kind: BlockKind; label: string; command: string }> = [
  { kind: 'paragraph', label: 'Párrafo', command: '/p' },
  { kind: 'h1', label: 'Título 1', command: '/h1' },
  { kind: 'h2', label: 'Título 2', command: '/h2' },
  { kind: 'h3', label: 'Título 3', command: '/h3' },
  { kind: 'h4', label: 'Título 4', command: '/h4' },
  { kind: 'h5', label: 'Título 5', command: '/h5' },
  { kind: 'h6', label: 'Título 6', command: '/h6' },
  { kind: 'bullet', label: 'Lista', command: '/lista' },
  { kind: 'numbered', label: 'Lista numerada', command: '/numerada' },
  { kind: 'todo', label: 'Tarea', command: '/tarea' },
  { kind: 'quote', label: 'Cita', command: '/cita' },
  { kind: 'info', label: 'Información', command: '/info' },
  { kind: 'code', label: 'Bloque de código', command: '/codigo' },
  { kind: 'divider', label: 'Separador', command: '/separador' },
]

const newId = () => `block-${crypto.randomUUID()}`
const makeBlock = (kind: BlockKind = 'paragraph', html = ''): RichBlock => ({ id: newId(), kind, html, checked: false })

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function htmlToBlocks(html: string): RichBlock[] {
  const doc = new DOMParser().parseFromString(html || '<p></p>', 'text/html')
  const blocks: RichBlock[] = []
  const add = (kind: BlockKind, inner = '', checked = false) => blocks.push({ id: newId(), kind, html: inner, checked })
  Array.from(doc.body.children).forEach((node) => {
    const tag = node.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) return add(tag as BlockKind, node.innerHTML)
    if (tag === 'p') return add('paragraph', node.innerHTML)
    if (tag === 'blockquote') return add('quote', node.innerHTML)
    if (tag === 'pre') return add('code', node.querySelector('code')?.innerHTML || node.innerHTML)
    if (tag === 'hr') return add('divider')
    if (tag === 'aside' && node.getAttribute('data-quata-block') === 'info') return add('info', node.innerHTML)
    if (tag === 'ul' || tag === 'ol') {
      Array.from(node.children).filter((child) => child.tagName.toLowerCase() === 'li').forEach((item) => {
        const isTodo = item.getAttribute('data-quata-todo') === 'true'
        add(isTodo ? 'todo' : tag === 'ol' ? 'numbered' : 'bullet', item.innerHTML, item.getAttribute('data-checked') === 'true')
      })
      return
    }
    add('paragraph', node.innerHTML || escapeHtml(node.textContent || ''))
  })
  return blocks.length ? blocks : [makeBlock()]
}

function blocksToHtml(blocks: RichBlock[]) {
  return blocks.map((block) => {
    const content = block.html || ''
    switch (block.kind) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return `<${block.kind}>${content}</${block.kind}>`
      case 'bullet': return `<ul><li>${content}</li></ul>`
      case 'numbered': return `<ol><li>${content}</li></ol>`
      case 'todo': return `<ul data-quata-list="todo"><li data-quata-todo="true" data-checked="${block.checked ? 'true' : 'false'}">${content}</li></ul>`
      case 'quote': return `<blockquote>${content}</blockquote>`
      case 'info': return `<aside data-quata-block="info">${content}</aside>`
      case 'code': return `<pre><code>${content}</code></pre>`
      case 'divider': return '<hr>'
      default: return `<p>${content}</p>`
    }
  }).join('')
}

function wrapRange(tag: string, className?: string, attributes?: Record<string, string>) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
  const range = selection.getRangeAt(0)
  const element = document.createElement(tag)
  if (className) element.className = className
  Object.entries(attributes || {}).forEach(([name, value]) => element.setAttribute(name, value))
  try { range.surroundContents(element) }
  catch {
    const fragment = range.extractContents()
    element.append(fragment)
    range.insertNode(element)
  }
  selection.removeAllRanges()
  const next = document.createRange()
  next.selectNodeContents(element)
  selection.addRange(next)
  return true
}

function BlockContent({ block, onChange, onAddAfter, onFocus }: { block: RichBlock; onChange: (html: string) => void; onAddAfter: () => void; onFocus: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const tag = block.kind === 'code' ? 'pre' : block.kind === 'quote' ? 'blockquote' : block.kind === 'info' ? 'aside' : /^h[1-6]$/.test(block.kind) ? block.kind : 'div'
  if (block.kind === 'divider') return <hr className="block-divider"/>
  return <div
    ref={(node) => {
      ref.current = node
      // Let the browser own the editable DOM while typing. Replacing innerHTML
      // during each React update resets the caret back to the beginning.
      if (node && document.activeElement !== node && node.innerHTML !== block.html) node.innerHTML = block.html
    }}
    className={`rich-block-content ${block.kind}`}
    contentEditable
    suppressContentEditableWarning
    role="textbox"
    data-tag={tag}
    onFocus={onFocus}
    onInput={(event) => onChange(event.currentTarget.innerHTML)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' && !event.shiftKey && (event.currentTarget.textContent || '').trim() === '') {
        event.preventDefault(); onAddAfter()
      }
    }}
  />
}

export function RichBlockEditor({ html, onChange }: { html: string; onChange: (html: string) => void }) {
  const [blocks, setBlocks] = useState<RichBlock[]>(() => htmlToBlocks(html))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [dragged, setDragged] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const inputRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lastHtml = useRef(html)

  useEffect(() => {
    if (html !== lastHtml.current) {
      lastHtml.current = html
      setBlocks(htmlToBlocks(html))
    }
  }, [html])
  const emit = (next: RichBlock[]) => {
    setBlocks(next)
    const output = blocksToHtml(next)
    lastHtml.current = output
    onChange(output)
  }
  const update = (id: string, patch: Partial<RichBlock>) => emit(blocks.map((block) => block.id === id ? { ...block, ...patch } : block))
  const addAfter = (id: string, kind: BlockKind = 'paragraph') => {
    const index = blocks.findIndex((block) => block.id === id)
    const nextBlock = makeBlock(kind)
    emit([...blocks.slice(0, index + 1), nextBlock, ...blocks.slice(index + 1)])
    window.setTimeout(() => inputRefs.current[nextBlock.id]?.focus(), 0)
  }
  const addBlock = (kind: BlockKind) => {
    const nextBlock = makeBlock(kind)
    emit([...blocks, nextBlock])
    setQuery('')
    window.setTimeout(() => inputRefs.current[nextBlock.id]?.focus(), 0)
  }
  const replaceKind = (id: string, kind: BlockKind) => update(id, { kind, checked: kind === 'todo' ? false : undefined })
  const deleteSelected = () => {
    const next = blocks.filter((block) => !selected.includes(block.id))
    emit(next.length ? next : [makeBlock()])
    setSelected([])
  }
  const format = (tag: string, options?: { className?: string; attributes?: Record<string, string> }) => {
    if (wrapRange(tag, options?.className, options?.attributes)) {
      const block = focusedId
      const content = block ? document.querySelector<HTMLElement>(`[data-block-id="${block}"] .rich-block-content`) : null
      if (block && content) update(block, { html: content.innerHTML })
    }
  }
  const showCommands = query.trim().startsWith('/')
  const filtered = useMemo(() => blockOptions.filter((option) => `${option.label} ${option.command}`.toLocaleLowerCase().includes(query.replace('/','').toLocaleLowerCase())), [query])
  const clearDrag = () => setDragged(null)
  const moveDraggedBefore = (targetId: string) => {
    if (!dragged || dragged === targetId) return
    const source = blocks.find((item) => item.id === dragged)
    if (!source) return
    const next = blocks.filter((item) => item.id !== dragged)
    next.splice(next.findIndex((item) => item.id === targetId), 0, source)
    emit(next)
  }
  return <section className="rich-block-editor" aria-label="Editor de contenido completo">
    <header className="rich-block-editor-header"><div><b>Contenido completo</b><small>Bloques, formato enriquecido y comandos</small></div>{selected.length > 0 && <button type="button" className="secondary danger-text" onClick={deleteSelected}><Trash2 size={15}/>Eliminar {selected.length} bloque{selected.length > 1 ? 's' : ''}</button>}</header>
    <div className="rich-inline-toolbar" aria-label="Formato de texto">
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('strong')} title="Negrita"><Bold size={16}/></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('em')} title="Cursiva"><Italic size={16}/></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('u')} title="Subrayado"><Underline size={16}/></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('s')} title="Tachado"><Strikethrough size={16}/></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('code')} title="Código"><Code2 size={16}/></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format('mark')} title="Resaltado"><Highlighter size={16}/></button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { const url = window.prompt('URL del enlace'); if (url) format('a', { attributes: { href: url, target: '_blank', rel: 'noreferrer' } }) }} title="Enlace"><Link size={16}/></button>
    </div>
    <div className="rich-slash"><Command size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Escribe / para buscar un tipo de bloque"/>{showCommands && <div className="rich-command-menu">{filtered.map((option) => <button key={option.kind} type="button" onClick={() => addBlock(option.kind)}><span>{option.label}</span><small>{option.command}</small></button>)}</div>}</div>
    <div className="rich-block-list">{blocks.map((block) => <article key={block.id} data-block-id={block.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { moveDraggedBefore(block.id); clearDrag() }} className={`rich-block-row ${selected.includes(block.id) ? 'selected' : ''} ${dragged === block.id ? 'dragging' : ''}`}>
      <button type="button" className="rich-select-block" aria-label="Seleccionar bloque" onClick={() => setSelected((current) => current.includes(block.id) ? current.filter((id) => id !== block.id) : [...current, block.id])}/>
      <span className="rich-drag" draggable onDragStart={() => setDragged(block.id)} onDragEnd={clearDrag} title="Arrastra para reordenar"><GripVertical size={17}/></span>
      <select aria-label="Tipo de bloque" value={block.kind} onChange={(event) => replaceKind(block.id, event.target.value as BlockKind)}>{blockOptions.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}</select>
      {block.kind === 'todo' && <input className="rich-todo" type="checkbox" checked={Boolean(block.checked)} onChange={(event) => update(block.id, { checked: event.target.checked })}/>} 
      <div className="rich-block-body" ref={(node) => { inputRefs.current[block.id] = node }}><BlockContent block={block} onFocus={() => setFocusedId(block.id)} onChange={(value) => update(block.id, { html: value })} onAddAfter={() => addAfter(block.id)}/></div>
      <button type="button" className="rich-add-after" onClick={() => addAfter(block.id)} title="Añadir bloque después"><PlusGlyph/></button>
    </article>)}</div>
    <div className="rich-block-quick-add"><button type="button" onClick={() => addBlock('bullet')}><List size={15}/>Lista</button><button type="button" onClick={() => addBlock('numbered')}><ListOrdered size={15}/>Numerada</button><button type="button" onClick={() => addBlock('todo')}><CheckSquare size={15}/>Tarea</button><button type="button" onClick={() => addBlock('quote')}><Quote size={15}/>Cita</button><button type="button" onClick={() => addBlock('info')}><Info size={15}/>Info</button><button type="button" onClick={() => addBlock('code')}><Code2 size={15}/>Código</button><button type="button" onClick={() => addBlock('divider')}><Minus size={15}/>Separador</button></div>
  </section>
}

function PlusGlyph() { return <span aria-hidden="true">+</span> }
