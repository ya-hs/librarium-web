// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 FireBall1725
//
// The camera as a barcode scanner, with a picker for which camera. It hands
// each book's code up once: a book held in frame is seen on every frame, and
// only a different code, or the same one after it left the frame, counts as
// a new scan.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBarcodeReader } from '../../lib/barcodeDetector'
import { pickCameraScan } from '../../lib/barcode'
import { openScanCamera } from '../../lib/camera'
import { Icon } from '../../lib/icons'

const CAMERA_KEY = 'librarium:add-books:camera'
// How long a code has to be out of frame before seeing it again is a new scan.
const GONE_MS = 2000

const readCamera = () => { try { return window.localStorage.getItem(CAMERA_KEY) } catch { return null } }
const storeCamera = (id: string) => { try { window.localStorage.setItem(CAMERA_KEY, id) } catch { /* not kept */ } }

export default function CameraView({ onCode, onStop, onError }: {
  onCode: (code: string) => void
  onStop: () => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(readCamera)
  // The detection loop outlives renders, so it reads the latest callback here.
  const onCodeRef = useRef(onCode)
  useEffect(() => { onCodeRef.current = onCode })
  const onErrorRef = useRef(onError)
  useEffect(() => { onErrorRef.current = onError })

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let frame = 0
    const start = async () => {
      try {
        stream = await openScanCamera(deviceId)
      } catch {
        // A remembered camera that's been unplugged: fall back to any camera.
        if (deviceId) { setDeviceId(null); return }
        onErrorRef.current(t('scan.camera_denied', { defaultValue: 'Camera access denied or unavailable.' }))
        return
      }
      if (stopped) { stream.getTracks().forEach(tr => tr.stop()); return }
      // Labels are only filled in once permission is given, so list them now.
      navigator.mediaDevices.enumerateDevices()
        .then(all => { if (!stopped) setCameras(all.filter(d => d.kind === 'videoinput')) })
        .catch(() => {})
      const video = videoRef.current
      if (!video) return
      let reader: Awaited<ReturnType<typeof getBarcodeReader>>
      try {
        video.srcObject = stream
        await video.play()
        reader = await getBarcodeReader()
      } catch {
        onErrorRef.current(t('scan.start_failed', { defaultValue: 'Could not start the barcode scanner.' }))
        return
      }
      let bareSince: number | null = null
      let last: { code: string; seen: number } | null = null
      const tick = async () => {
        if (stopped) return
        try {
          const codes = await reader.detect(video)
          const now = performance.now()
          if (codes.length > 0) {
            // A bare UPC waits a moment for its add-on, the way One book did.
            const code = pickCameraScan(codes.map(c => c.rawValue), bareSince, now)
            if (code === null) bareSince ??= now
            else {
              bareSince = null
              if (!last || last.code !== code || now - last.seen > GONE_MS) onCodeRef.current(code)
              last = { code, seen: now }
            }
          }
        } catch {
          // A frame mid-resize can fail to decode; the next one won't.
        }
        frame = requestAnimationFrame(() => { void tick() })
      }
      void tick()
    }
    void start()
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(tr => tr.stop())
    }
  }, [deviceId, t])

  const pick = useCallback((id: string) => { setDeviceId(id); storeCamera(id) }, [])
  const switchCamera = () => {
    if (cameras.length < 2) return
    const i = cameras.findIndex(c => c.deviceId === deviceId)
    pick(cameras[(i + 1) % cameras.length].deviceId)
  }

  return (
    <div className="space-y-2.5">
      <div className="relative overflow-hidden rounded-xl bg-black">
        <video ref={videoRef} className="aspect-video w-full object-cover" playsInline muted />
        {/* The frame to aim for; a paperback's add-on sits to the right of its UPC. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-[14%] inset-y-[28%] rounded-lg border-2 border-white/80" />
      </div>
      <p className="text-center text-[12.5px] text-content-muted">
        {t('add_books.camera_hint', { defaultValue: 'Hold the barcode inside the frame, add-on and all' })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {cameras.length > 1 && (
          <select id="add-books-camera" aria-label={t('add_books.camera', { defaultValue: 'Camera' })}
            className="lb-field w-auto! max-w-[16rem] py-1! text-[12.5px]!"
            value={deviceId ?? cameras[0].deviceId}
            onChange={e => pick(e.target.value)}>
            {cameras.map((c, i) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label || t('add_books.camera_n', { n: i + 1, defaultValue: 'Camera {{n}}' })}
              </option>
            ))}
          </select>
        )}
        {cameras.length > 1 && (
          <button type="button" className="lb-btn ghost sm inline-flex items-center gap-1.5" onClick={switchCamera}>
            <Icon name="swap" className="h-3.5 w-3.5" />
            {t('add_books.switch_camera', { defaultValue: 'Switch camera' })}
          </button>
        )}
        <button type="button" className="lb-btn ghost sm ml-auto inline-flex items-center gap-1.5" onClick={onStop}>
          <Icon name="close" className="h-3.5 w-3.5" />
          {t('add_books.stop_camera', { defaultValue: 'Stop camera' })}
        </button>
      </div>
    </div>
  )
}
