import { useEffect, useMemo, useRef, useState } from 'react'
import Cropper, { Area } from 'react-easy-crop'
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM } from 'mediabunny'
import { Check, Crop, FlipHorizontal2, LoaderCircle, RotateCw, Scissors, Volume2, VolumeX, X } from 'lucide-react'

type MediaKind = 'image' | 'video'
type CropPreset = 'original' | 'square' | 'fourFive' | 'portrait' | 'landscape'
const MIN_TRIM_SECONDS = .5
const MAX_TRIM_SECONDS = 90

const presets: Array<{ id: CropPreset; label: string; aspect?: number }> = [
  { id: 'original', label: 'Original' },
  { id: 'square', label: '1:1', aspect: 1 },
  { id: 'fourFive', label: '4:5', aspect: 4 / 5 },
  { id: 'portrait', label: '9:16', aspect: 9 / 16 },
  { id: 'landscape', label: '16:9', aspect: 16 / 9 },
]

type Props = { file: File; onCancel: () => void; onSave: (file: File, kind: MediaKind) => Promise<void> }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const filenameBase = (name: string, fallback: string) => name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : `${name}.${fallback}`
const formatTime = (value: number) => {
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = source
  })
}

function getVideoDuration(source: string) {
  return new Promise<number>((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => resolve(Number.isFinite(video.duration) ? video.duration : 0)
    video.onerror = () => resolve(0)
    video.src = source
  })
}

async function renderImage(source: string, area: Area, rotation: number, flip: boolean, name: string) {
  const image = await loadImage(source)
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = Math.max(1, Math.round(area.width))
  sourceCanvas.height = Math.max(1, Math.round(area.height))
  sourceCanvas.getContext('2d')!.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, sourceCanvas.width, sourceCanvas.height)
  const rotated = rotation % 180 !== 0
  const output = document.createElement('canvas')
  output.width = rotated ? sourceCanvas.height : sourceCanvas.width
  output.height = rotated ? sourceCanvas.width : sourceCanvas.height
  const context = output.getContext('2d')!
  context.translate(output.width / 2, output.height / 2)
  context.rotate(rotation * Math.PI / 180)
  context.scale(flip ? -1 : 1, 1)
  context.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2)
  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/jpeg', .92))
  if (!blob) throw new Error('No se ha podido preparar la imagen')
  return new File([blob], `${filenameBase(name, 'imagen')}.jpg`, { type: 'image/jpeg' })
}

async function renderVideo(file: File, crop: Area, rotation: number, trimStart: number, trimEnd: number, muted: boolean, onProgress: (progress: number) => void) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const cropRect = { left: Math.max(0, Math.round(crop.x)), top: Math.max(0, Math.round(crop.y)), width: Math.max(2, Math.round(crop.width)), height: Math.max(2, Math.round(crop.height)) }
  let sourceCanvas: OffscreenCanvas | null = null
  let sourceContext: OffscreenCanvasRenderingContext2D | null = null
  let compositionCanvas: OffscreenCanvas | null = null
  let compositionContext: OffscreenCanvasRenderingContext2D | null = null
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    trim: { start: trimStart, end: Math.max(trimStart + MIN_TRIM_SECONDS, trimEnd) },
    video: {
      crop: cropRect,
      rotate: (rotation % 360) as 0 | 90 | 180 | 270,
      allowRotationMetadata: false,
      bitrate: QUALITY_MEDIUM,
      forceTranscode: true,
      processedWidth: 720,
      processedHeight: 1280,
      process: (sample) => {
        if (!sourceCanvas || sourceCanvas.width !== sample.displayWidth || sourceCanvas.height !== sample.displayHeight) {
          sourceCanvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight)
          sourceContext = sourceCanvas.getContext('2d')!
          compositionCanvas = new OffscreenCanvas(720, 1280)
          compositionContext = compositionCanvas.getContext('2d')!
        }
        sourceContext!.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height)
        sample.draw(sourceContext!, 0, 0)
        const context = compositionContext!
        context.clearRect(0, 0, 720, 1280)
        const backgroundScale = Math.max(720 / sourceCanvas.width, 1280 / sourceCanvas.height)
        const backgroundWidth = sourceCanvas.width * backgroundScale
        const backgroundHeight = sourceCanvas.height * backgroundScale
        context.filter = 'blur(18px) brightness(.68)'
        context.drawImage(sourceCanvas, (720 - backgroundWidth) / 2, (1280 - backgroundHeight) / 2, backgroundWidth, backgroundHeight)
        context.filter = 'none'
        const foregroundScale = Math.min(720 / sourceCanvas.width, 1280 / sourceCanvas.height)
        const foregroundWidth = sourceCanvas.width * foregroundScale
        const foregroundHeight = sourceCanvas.height * foregroundScale
        context.drawImage(sourceCanvas, (720 - foregroundWidth) / 2, (1280 - foregroundHeight) / 2, foregroundWidth, foregroundHeight)
        return compositionCanvas!
      },
    },
    audio: muted ? { discard: true } : { bitrate: QUALITY_MEDIUM },
    tags: {},
  })
  if (!conversion.isValid) throw new Error('El navegador no puede transformar este vídeo')
  conversion.onProgress = onProgress
  await conversion.execute()
  if (!output.target.buffer) throw new Error('La exportación no produjo un archivo de vídeo')
  return new File([output.target.buffer], `${filenameBase(file.name, 'video')}-quata.mp4`, { type: 'video/mp4' })
}

type TimelineProps = {
  source: string
  duration: number
  trimStart: number
  trimEnd: number
  currentTime: number
  onTrimChange: (start: number, end: number) => void
  onSeek: (time: number) => void
}

function useTimelineFrames(source: string, duration: number) {
  const [frames, setFrames] = useState<string[]>([])
  useEffect(() => {
    if (!source || duration <= 0) { setFrames([]); return }
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    const capture = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 90
      const context = canvas.getContext('2d')
      if (!context) return
      const images: string[] = []
      for (let index = 0; index < 6 && !cancelled; index += 1) {
        const target = Math.min(duration - .05, Math.max(.01, duration * index / 5))
        await new Promise<void>((resolve) => {
          const done = () => resolve()
          video.onseeked = done
          video.onerror = done
          video.currentTime = target
        })
        if (cancelled) return
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        images.push(canvas.toDataURL('image/jpeg', .7))
      }
      if (!cancelled) setFrames(images)
    }
    video.onloadeddata = () => { void capture() }
    video.src = source
    return () => { cancelled = true; video.removeAttribute('src'); video.load() }
  }, [duration, source])
  return frames
}

function VideoTrimTimeline({ source, duration, trimStart, trimEnd, currentTime, onTrimChange, onSeek }: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragMode = useRef<'start' | 'end' | 'playhead' | null>(null)
  const frames = useTimelineFrames(source, duration)
  const safeDuration = Math.max(duration, 1)
  const maxRange = Math.min(MAX_TRIM_SECONDS, duration)
  const startPercent = trimStart / safeDuration * 100
  const endPercent = trimEnd / safeDuration * 100
  const playheadPercent = clamp(currentTime, 0, safeDuration) / safeDuration * 100
  const pointerTime = (clientX: number) => {
    const box = timelineRef.current?.getBoundingClientRect()
    if (!box) return 0
    return clamp((clientX - box.left) / Math.max(box.width, 1) * duration, 0, duration)
  }
  const apply = (mode: 'start' | 'end' | 'playhead', clientX: number) => {
    const target = pointerTime(clientX)
    if (mode === 'playhead') return onSeek(target)
    if (mode === 'start') {
      const start = clamp(target, 0, Math.max(0, trimEnd - MIN_TRIM_SECONDS))
      const end = trimEnd - start > maxRange ? Math.min(duration, start + maxRange) : trimEnd
      onTrimChange(start, end)
      onSeek(start)
      return
    }
    const end = clamp(target, Math.min(duration, trimStart + MIN_TRIM_SECONDS), duration)
    const start = end - trimStart > maxRange ? Math.max(0, end - maxRange) : trimStart
    onTrimChange(start, end)
    onSeek(start)
  }
  const onPointerDown = (mode: 'start' | 'end' | 'playhead', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragMode.current = mode
    event.currentTarget.setPointerCapture(event.pointerId)
    apply(mode, event.clientX)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode.current) apply(dragMode.current, event.clientX)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragMode.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div className="video-trim-timeline-wrap">
    <div className="video-trim-timeline-labels"><span>{formatTime(trimStart)}</span><span>{formatTime(trimEnd)} / {formatTime(duration)}</span></div>
    <div ref={timelineRef} className="video-trim-timeline" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerDown={(event) => onPointerDown('playhead', event)}>
      <div className="video-trim-filmstrip" aria-hidden="true">{frames.length ? frames.map((frame, index) => <img key={`${index}-${frame.slice(-12)}`} src={frame} alt=""/>) : <><i/><i/><i/><i/><i/><i/></>}</div>
      <div className="video-trim-mask before" style={{ width: `${startPercent}%` }}/>
      <div className="video-trim-mask after" style={{ left: `${endPercent}%` }}/>
      <div className="video-trim-selection" style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}/>
      <div className="video-trim-playhead" style={{ left: `${playheadPercent}%` }} onPointerDown={(event) => { event.stopPropagation(); onPointerDown('playhead', event) }} title="Mover reproducción"/>
      <div className="video-trim-handle start" style={{ left: `${startPercent}%` }} onPointerDown={(event) => { event.stopPropagation(); onPointerDown('start', event) }} aria-label="Inicio del recorte"/>
      <div className="video-trim-handle end" style={{ left: `${endPercent}%` }} onPointerDown={(event) => { event.stopPropagation(); onPointerDown('end', event) }} aria-label="Fin del recorte"/>
    </div>
    <p>Arrastra las asas para elegir el fragmento. Máximo 1:30 min.</p>
  </div>
}

export function OfficialMediaEditor({ file, onCancel, onSave }: Props) {
  const kind: MediaKind = file.type.startsWith('video/') ? 'video' : 'image'
  const [source] = useState(() => URL.createObjectURL(file))
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [cropArea, setCropArea] = useState<Area>({ x: 0, y: 0, width: 1, height: 1 })
  const [preset, setPreset] = useState<CropPreset>('portrait')
  const [rotation, setRotation] = useState(0)
  const [flip, setFlip] = useState(false)
  const [muted, setMuted] = useState(false)
  const [duration, setDuration] = useState(0)
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [videoPosition, setVideoPosition] = useState({ x: .5, y: .5 })
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const videoPreviewRef = useRef<HTMLVideoElement>(null)
  const aspect = presets.find((item) => item.id === preset)?.aspect

  useEffect(() => { if (kind === 'video') void getVideoDuration(source).then((value) => { setDuration(value); setTrimEnd(Math.min(value, MAX_TRIM_SECONDS)) }) }, [kind, source])
  const safeEnd = useMemo(() => Math.max(trimStart + MIN_TRIM_SECONDS, trimEnd), [trimEnd, trimStart])
  const videoCropArea = useMemo<Area>(() => {
    if (!videoSize.width || !videoSize.height) return cropArea
    const sourceAspect = videoSize.width / videoSize.height
    const targetAspect = aspect || sourceAspect
    let width = videoSize.width
    let height = videoSize.height
    if (sourceAspect > targetAspect) width = height * targetAspect
    else height = width / targetAspect
    width /= zoom
    height /= zoom
    return { width: Math.round(width), height: Math.round(height), x: Math.round((videoSize.width - width) * videoPosition.x), y: Math.round((videoSize.height - height) * videoPosition.y) }
  }, [aspect, cropArea, videoPosition, videoSize, zoom])
  const seekVideo = (time: number) => {
    const target = clamp(time, 0, duration)
    setCurrentTime(target)
    if (videoPreviewRef.current) videoPreviewRef.current.currentTime = target
  }
  const restartTrimPreview = (video: HTMLVideoElement, resume: boolean) => {
    video.currentTime = trimStart
    setCurrentTime(trimStart)
    if (resume) void video.play().catch(() => undefined)
  }
  const save = async () => {
    setBusy(true)
    setProgress(0)
    try {
      const result = kind === 'image'
        ? await renderImage(source, cropArea, rotation, flip, file.name)
        : await renderVideo(file, videoCropArea, rotation, trimStart, safeEnd, muted, setProgress)
      await onSave(result, kind)
    } finally { setBusy(false) }
  }
  const reset = () => {
    setCrop({ x: 0, y: 0 }); setVideoPosition({ x: .5, y: .5 }); setZoom(1); setRotation(0); setFlip(false); setMuted(false); setPreset('portrait'); setTrimStart(0); setTrimEnd(Math.min(duration, MAX_TRIM_SECONDS)); seekVideo(0)
  }

  return <div className="media-editor-backdrop" role="dialog" aria-modal="true" aria-label={`Editor de ${kind === 'video' ? 'vídeo' : 'imagen'}`}>
    <section className="media-editor-modal">
      <header><div><b>Editor de {kind === 'video' ? 'vídeo' : 'imagen'}</b><small>{file.name}</small></div><button className="icon" disabled={busy} onClick={onCancel} title="Cancelar"><X size={20}/></button></header>
      <div className="media-editor-toolbar">
        <button type="button" className={rotation ? 'active' : ''} onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw size={17}/><span>Rotar</span></button>
        <button type="button" className={flip ? 'active' : ''} onClick={() => setFlip((value) => !value)}><FlipHorizontal2 size={17}/><span>Voltear</span></button>
        {kind === 'video' && <button type="button" className={muted ? 'active' : ''} onClick={() => setMuted((value) => !value)}>{muted ? <VolumeX size={17}/> : <Volume2 size={17}/>}<span>{muted ? 'Silenciado' : 'Sonido'}</span></button>}
        <button type="button" onClick={reset}><Crop size={17}/><span>Restablecer</span></button>
      </div>
      <main className="media-editor-workspace">
        <div className="media-cropper-wrap">
          {kind === 'image'
            ? <Cropper image={source} crop={crop} zoom={zoom} rotation={rotation} aspect={aspect} onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={(_, pixels) => setCropArea(pixels)} objectFit="contain" transform={`translate(${crop.x}px, ${crop.y}px) rotate(${rotation}deg) scale(${zoom}) scaleX(${flip ? -1 : 1})`} />
            : <div className="native-video-crop" style={{ aspectRatio: aspect || (videoSize.width && videoSize.height ? `${videoSize.width}/${videoSize.height}` : '9/16') }}>
                <video ref={videoPreviewRef} src={source} controls autoPlay playsInline onPlay={(event) => { const video = event.currentTarget; if (video.currentTime < trimStart || video.currentTime >= safeEnd) seekVideo(trimStart) }} onTimeUpdate={(event) => { const video = event.currentTarget; if (video.currentTime >= safeEnd) { restartTrimPreview(video, !video.paused); return }; setCurrentTime(video.currentTime) }} onEnded={(event) => restartTrimPreview(event.currentTarget, true)} onLoadedMetadata={(event) => { const video = event.currentTarget; setDuration(video.duration); setTrimEnd(Math.min(video.duration, MAX_TRIM_SECONDS)); setVideoSize({ width: video.videoWidth, height: video.videoHeight }) }} style={{ objectPosition: `${videoPosition.x * 100}% ${videoPosition.y * 100}%`, transform: `rotate(${rotation}deg) scale(${zoom}) scaleX(${flip ? -1 : 1})` }}/>
              </div>}
        </div>
        <aside className="media-editor-controls">
          <div><b>Recorte</b><div className="crop-presets">{presets.map((item) => <button type="button" key={item.id} className={preset === item.id ? 'active' : ''} onClick={() => setPreset(item.id)}>{item.label}</button>)}</div></div>
          <label>Zoom<input type="range" min="1" max="3" step=".01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}/></label>
          {kind === 'video' && <>
            <div className="video-position"><b>Posición</b><label>Horizontal<input type="range" min="0" max="1" step=".01" value={videoPosition.x} onChange={(event) => setVideoPosition((value) => ({ ...value, x: Number(event.target.value) }))}/></label><label>Vertical<input type="range" min="0" max="1" step=".01" value={videoPosition.y} onChange={(event) => setVideoPosition((value) => ({ ...value, y: Number(event.target.value) }))}/></label></div>
            <div className="video-trim"><b><Scissors size={15}/>Recorte temporal</b><VideoTrimTimeline source={source} duration={duration} trimStart={trimStart} trimEnd={safeEnd} currentTime={currentTime} onTrimChange={(start, end) => { setTrimStart(start); setTrimEnd(end) }} onSeek={seekVideo}/></div>
          </>}
        </aside>
      </main>
      <footer>{busy ? <span className="media-export-progress"><LoaderCircle size={17} className="spin"/>Procesando {kind === 'video' ? `${Math.round(progress * 100)}%` : 'imagen'}…</span> : <span>{kind === 'video' ? 'Vídeo MP4 optimizado para el muro oficial' : 'Imagen exportada con el encuadre seleccionado'}</span>}<div><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}><Check size={17}/>{busy ? 'Procesando…' : 'Usar archivo'}</button></div></footer>
    </section>
  </div>
}
