// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 FireBall1725

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openScanCamera } from './camera'

// jsdom has no camera, so each test describes the one it wants.
function fakeStream(label: string, deviceId: string, focusModes?: string[], applyConstraints = vi.fn().mockResolvedValue(undefined)) {
  const track = {
    label,
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
    getCapabilities: focusModes === undefined ? undefined : () => ({ focusMode: focusModes }),
    applyConstraints,
  }
  return { track, stream: { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream }
}

const device = (deviceId: string, label: string) => ({ deviceId, label, kind: 'videoinput' }) as MediaDeviceInfo

const getUserMedia = vi.fn()
const enumerateDevices = vi.fn()

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  })
})

afterEach(() => {
  getUserMedia.mockReset()
  enumerateDevices.mockReset()
})

describe('openScanCamera', () => {
  it('asks for the rear camera at 1080p', async () => {
    const { stream } = fakeStream('camera2 0, facing back', 'a')
    getUserMedia.mockResolvedValue(stream)
    expect(await openScanCamera()).toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
    expect(enumerateDevices).not.toHaveBeenCalled()
  })

  it('uses a picked camera exactly and never swaps it', async () => {
    const { stream } = fakeStream('Back Ultra Wide Camera', 'uw')
    getUserMedia.mockResolvedValue(stream)
    expect(await openScanCamera('uw')).toBe(stream)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: 'uw' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
  })

  it('moves off an ultrawide lens to the main rear camera', async () => {
    const wide = fakeStream('Back Ultra Wide Camera', 'uw')
    const main = fakeStream('Back Camera', 'main')
    getUserMedia.mockResolvedValueOnce(wide.stream).mockResolvedValueOnce(main.stream)
    enumerateDevices.mockResolvedValue([
      device('front', 'Front Camera'), device('uw', 'Back Ultra Wide Camera'), device('main', 'Back Camera'),
    ])
    expect(await openScanCamera()).toBe(main.stream)
    expect(wide.track.stop).toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { deviceId: { exact: 'main' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
  })

  it('keeps the ultrawide when there is no other rear camera', async () => {
    const wide = fakeStream('Back Ultra Wide Camera', 'uw')
    getUserMedia.mockResolvedValue(wide.stream)
    enumerateDevices.mockResolvedValue([device('front', 'Front Camera'), device('uw', 'Back Ultra Wide Camera')])
    expect(await openScanCamera()).toBe(wide.stream)
    expect(wide.track.stop).not.toHaveBeenCalled()
  })

  it('reopens the default camera when the swap fails', async () => {
    const wide = fakeStream('Back Ultra Wide Camera', 'uw')
    const again = fakeStream('Back Ultra Wide Camera', 'uw')
    getUserMedia.mockResolvedValueOnce(wide.stream)
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(again.stream)
    enumerateDevices.mockResolvedValue([device('uw', 'Back Ultra Wide Camera'), device('main', 'Back Camera')])
    expect(await openScanCamera()).toBe(again.stream)
  })

  it('turns on continuous focus only where the camera offers it', async () => {
    const focusing = fakeStream('Back Camera', 'a', ['manual', 'continuous'])
    getUserMedia.mockResolvedValueOnce(focusing.stream)
    await openScanCamera()
    expect(focusing.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] })

    const fixed = fakeStream('Back Camera', 'a', ['manual'])
    getUserMedia.mockResolvedValueOnce(fixed.stream)
    await openScanCamera()
    expect(fixed.track.applyConstraints).not.toHaveBeenCalled()

    const noCaps = fakeStream('Back Camera', 'a')
    getUserMedia.mockResolvedValueOnce(noCaps.stream)
    await openScanCamera()
    expect(noCaps.track.applyConstraints).not.toHaveBeenCalled()
  })

  it('still returns the stream when focus can’t be applied', async () => {
    const { stream } = fakeStream('Back Camera', 'a', ['continuous'], vi.fn().mockRejectedValue(new Error('no')))
    getUserMedia.mockResolvedValue(stream)
    expect(await openScanCamera()).toBe(stream)
  })

  it('passes a refusal through to the caller', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await expect(openScanCamera()).rejects.toThrow('denied')
  })
})
