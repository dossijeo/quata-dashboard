import { useEffect, useRef, useState } from 'react'

export type EvidencePoint = {
  evidenceId: string
  latitude: number
  longitude: number
  label: string
  accuracyMeters?: number
  inferred?: boolean
  ambiguous?: boolean
  confidence?: number
}

type Props = {
  points: EvidencePoint[]
  segments: Array<[EvidencePoint, EvidencePoint]>
  focusedEvidenceId?: string
  onSelect: (evidenceId: string) => void
}

let googleMapsPromise: Promise<void> | null = null

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] || character)
}

function loadGoogleMaps() {
  if (window.google?.maps) return Promise.resolve()
  if (googleMapsPromise) return googleMapsPromise
  const key = import.meta.env.VITE_GOOGLE_MAPS_JS_API_KEY
  if (!key) return Promise.reject(new Error('google_maps_not_configured'))
  googleMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('google_maps_load_failed'))
    document.head.appendChild(script)
  })
  return googleMapsPromise
}

export function GoogleEvidenceMap({ points, segments, focusedEvidenceId, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const overlays = useRef<Array<google.maps.Circle | google.maps.Polyline>>([])
  const infoWindow = useRef<google.maps.InfoWindow | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    loadGoogleMaps()
      .then(() => {
        if (!active || !container.current) return
        if (!mapRef.current) {
          mapRef.current = new google.maps.Map(container.current, {
            center: { lat: 1.8, lng: 10 },
            zoom: 6,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            gestureHandling: 'greedy',
          })
          infoWindow.current = new google.maps.InfoWindow()
        }

        overlays.current.forEach((overlay) => overlay.setMap(null))
        overlays.current = []
        const bounds = new google.maps.LatLngBounds()
        points.forEach((point) => {
          const center = { lat: point.latitude, lng: point.longitude }
          bounds.extend(center)
          const circle = new google.maps.Circle({
            map: mapRef.current,
            center,
            radius: Math.max(point.ambiguous ? 300 : point.inferred ? 180 : 80, point.accuracyMeters || 0),
            strokeColor: point.ambiguous ? '#d97706' : point.inferred ? '#2563eb' : '#f97316',
            strokeOpacity: 1,
            strokeWeight: 3,
            fillColor: point.ambiguous ? '#f59e0b' : point.inferred ? '#2563eb' : '#f97316',
            fillOpacity: point.inferred ? 0.35 : 0.28,
            clickable: true,
          })
          circle.addListener('click', () => {
            onSelect(point.evidenceId)
            const heading = point.ambiguous ? 'Coincidencia ambigua' : point.inferred ? 'Ubicación inferida' : 'Punto observado'
            infoWindow.current?.setContent(
              `<div class="security-google-popup"><b>${heading}</b><span>${escapeHtml(point.label)}</span>${point.confidence ? `<small>Confianza ${(point.confidence * 100).toFixed(0)}%</small>` : ''}</div>`,
            )
            infoWindow.current?.setPosition(center)
            infoWindow.current?.open({ map: mapRef.current })
          })
          overlays.current.push(circle)
        })
        segments.forEach(([start, end]) => {
          const line = new google.maps.Polyline({
            map: mapRef.current,
            path: [
              { lat: start.latitude, lng: start.longitude },
              { lat: end.latitude, lng: end.longitude },
            ],
            strokeColor: '#f97316',
            strokeOpacity: 0,
            icons: [{
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 2 },
              offset: '0',
              repeat: '14px',
            }],
          })
          overlays.current.push(line)
        })
        const focusedPoint = points.find((point) => point.evidenceId === focusedEvidenceId)
        if (focusedPoint) {
          mapRef.current.setCenter({ lat: focusedPoint.latitude, lng: focusedPoint.longitude })
          mapRef.current.setZoom(focusedPoint.ambiguous ? 14 : focusedPoint.inferred ? 15 : 16)
        } else if (points.length === 1) {
          infoWindow.current?.close()
          mapRef.current.setCenter(bounds.getCenter())
          mapRef.current.setZoom(8)
        } else if (points.length > 1) {
          infoWindow.current?.close()
          mapRef.current.fitBounds(bounds, 45)
          google.maps.event.addListenerOnce(mapRef.current, 'idle', () => {
            if (!active || !mapRef.current) return
            const zoom = mapRef.current.getZoom()
            if (zoom !== undefined && zoom > 9) mapRef.current.setZoom(9)
          })
        } else {
          infoWindow.current?.close()
          mapRef.current.setCenter({ lat: 1.8, lng: 10 })
          mapRef.current.setZoom(6)
        }
        setError('')
      })
      .catch(() => { if (active) setError('No se ha podido cargar Google Maps.') })
    return () => { active = false }
  }, [points, segments, focusedEvidenceId, onSelect])

  return <div className="security-google-map-shell">
    <div ref={container} className="security-map"/>
    {error && <div className="security-map-error">{error}</div>}
  </div>
}
