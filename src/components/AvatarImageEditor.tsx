import { useEffect, useState } from 'react'
import Cropper, { Area } from 'react-easy-crop'
import { Check, FlipHorizontal2, RotateCw, Upload, X } from 'lucide-react'

type Props = { file: File; onCancel: () => void; onSave: (file: File) => Promise<void> }

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

function sourceImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = source
  })
}

async function renderAvatar(source: string, crop: Area, rotation: number, flip: boolean, originalName: string) {
  const image = await sourceImage(source)
  const cut = document.createElement('canvas')
  cut.width = Math.max(1, Math.round(crop.width))
  cut.height = Math.max(1, Math.round(crop.height))
  cut.getContext('2d')!.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, cut.width, cut.height)
  const transformed = document.createElement('canvas')
  transformed.width = cut.height
  transformed.height = cut.width
  const transformedContext = transformed.getContext('2d')!
  transformedContext.translate(transformed.width / 2, transformed.height / 2)
  transformedContext.rotate(rotation * Math.PI / 180)
  transformedContext.scale(flip ? -1 : 1, 1)
  transformedContext.drawImage(cut, -cut.width / 2, -cut.height / 2)
  const output = document.createElement('canvas')
  output.width = 1080
  output.height = 1080
  output.getContext('2d')!.drawImage(transformed, 0, 0, output.width, output.height)
  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/jpeg', .92))
  if (!blob) throw new Error('No se ha podido preparar la imagen')
  const base = originalName.includes('.') ? originalName.slice(0, originalName.lastIndexOf('.')) : originalName
  return new File([blob], `${base || 'perfil'}.jpg`, { type: 'image/jpeg' })
}

export function AvatarImageEditor({ file, onCancel, onSave }: Props) {
  const [source, setSource] = useState('')
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [flip, setFlip] = useState(false)
  const [area, setArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const next = URL.createObjectURL(file)
    setSource(next)
    return () => URL.revokeObjectURL(next)
  }, [file])

  const save = async () => {
    if (!source || !area) return
    setBusy(true)
    try { await onSave(await renderAvatar(source, area, rotation, flip, file.name)) }
    finally { setBusy(false) }
  }

  return <div className="avatar-editor-backdrop" role="dialog" aria-modal="true" aria-label="Editar imagen de perfil">
    <section className="avatar-editor-modal">
      <header><div><h2>Editar imagen de perfil</h2><p>Encuadra tu imagen en formato cuadrado.</p></div><button className="icon" onClick={onCancel} disabled={busy} title="Cerrar"><X size={20} /></button></header>
      <div className="avatar-editor-tools">
        <button className="secondary" onClick={() => setRotation((value) => (value + 90) % 360)} disabled={busy}><RotateCw size={16} />Rotar</button>
        <button className="secondary" onClick={() => setFlip((value) => !value)} disabled={busy}><FlipHorizontal2 size={16} />Voltear</button>
        <button className="secondary" onClick={() => { setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0); setFlip(false) }} disabled={busy}>Restablecer</button>
      </div>
      <div className="avatar-editor-stage">
        {source && <Cropper image={source} crop={crop} zoom={zoom} rotation={rotation} aspect={1} onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={(_, pixels) => setArea(pixels)} transform={`translate(${crop.x}px, ${crop.y}px) rotate(${rotation}deg) scale(${flip ? -1 : 1}, 1) scale(${zoom})`} />}
      </div>
      <div className="avatar-editor-zoom"><span>Zoom</span><input type="range" min="1" max="3" step=".01" value={zoom} onChange={(event) => setZoom(clamp(Number(event.target.value), 1, 3))} /></div>
      <footer><small><Upload size={15} /> Se guardará una imagen cuadrada optimizada para tu perfil.</small><div><button className="secondary" onClick={onCancel} disabled={busy}>Cancelar</button><button className="primary" onClick={() => void save()} disabled={busy || !area}>{busy ? 'Preparando...' : <><Check size={16} />Usar imagen</>}</button></div></footer>
    </section>
  </div>
}
