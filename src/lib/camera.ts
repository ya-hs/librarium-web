// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 FireBall1725
//
// Opening the camera for the barcode scanner.
//
// Asking for nothing but `facingMode: 'environment'` lets the browser pick any
// rear lens, and on Android Chrome that is often the ultrawide: it is usually
// fixed-focus and lower resolution, so a barcode held close comes out blurry
// and never decodes. Three things steer it back to the main
// lens, each falling back quietly when the browser can't do it.

// The main lens is usually the only rear camera that delivers 1080p, so asking
// for it nudges Chrome's choice. barcodeDetector downscales frames before
// decoding, so the larger stream costs no decode time.
const RESOLUTION = { width: { ideal: 1920 }, height: { ideal: 1080 } }

const WIDE = /ultra|wide/i
const REAR = /back|rear|environment/i

// focusMode is in the Media Capture spec but not in TypeScript's DOM lib.
type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] }

const stopAll = (stream: MediaStream) => stream.getTracks().forEach(tr => tr.stop())

/**
 * A camera stream for scanning. With a deviceId, that camera exactly, since
 * someone picked it by hand. Without one, the rear camera, steered away from
 * an ultrawide lens where the labels say which one that is.
 *
 * Rejects only when the first request does, so callers' "camera denied"
 * handling is unchanged.
 */
export async function openScanCamera(deviceId?: string | null): Promise<MediaStream> {
  if (deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, ...RESOLUTION },
    })
    await focusContinuously(stream)
    return stream
  }

  let stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, ...RESOLUTION },
  })
  stream = await avoidUltrawide(stream)
  await focusContinuously(stream)
  return stream
}

// Labels are only filled in once permission is given, so this has to come
// after the first stream. Many Android builds label lenses only as
// "camera2 N, facing back", in which case there is nothing to go on and the
// stream is kept as it is.
async function avoidUltrawide(stream: MediaStream): Promise<MediaStream> {
  const track = stream.getVideoTracks()[0]
  if (!track || !WIDE.test(track.label)) return stream
  let main: MediaDeviceInfo | undefined
  try {
    const current = track.getSettings().deviceId
    const devices = await navigator.mediaDevices.enumerateDevices()
    main = devices.find(d =>
      d.kind === 'videoinput' && d.deviceId !== current
      && REAR.test(d.label) && !WIDE.test(d.label))
  } catch {
    return stream
  }
  if (!main) return stream
  // Some phones can't hold two rear cameras open at once, so the first one
  // closes before the second opens.
  stopAll(stream)
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: main.deviceId }, ...RESOLUTION },
    })
  } catch {
    // The swap failed; the first camera is better than none.
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, ...RESOLUTION },
    })
  }
}

async function focusContinuously(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0]
  if (!track || typeof track.getCapabilities !== 'function') return
  try {
    const caps = track.getCapabilities() as FocusCapabilities
    if (!caps.focusMode?.includes('continuous')) return
    await track.applyConstraints({
      advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
    })
  } catch {
    // Focus is a nicety; the camera works without it.
  }
}
