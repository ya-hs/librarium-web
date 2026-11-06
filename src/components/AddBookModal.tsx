// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 FireBall1725
//
// Adding a book: by ISBN, by provider search, or by hand.
//
// Extracted from LibraryPage, where it was 985 of that file's 6,235 lines and
// reachable only from the per-library grid. Adding a book is not a per-library
// act in the redesign — a library is a filter now — so the modal takes an
// optional libraryId and asks which library when it has none.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth, ApiError } from '../auth/AuthContext'
import type { Book, BookEdition, ContributorResult, Genre, ISBNLookupResult, Library, MediaType, MergedBookResult, Tag } from '../types'
import { fetchLists, type SavedList } from '../lib/lists'
import { LANGUAGE_OPTIONS } from './AddEditionModal'
import ContributorRow, { CONTRIBUTOR_ROLES } from './ContributorRow'
import { joinWithAbove } from '../lib/contributors'
import MediaTypeSelect from './MediaTypeSelect'
import SeriesRowsField from './SeriesRowsField'
import { saveSeriesRows, type SeriesRowDraft } from '../lib/seriesRows'
import MergedLookup from './MergedLookup'
import { hasAnyField, mergedToResult } from '../lib/mergedLookup'
import { TAG_COLORS } from '../lib/tagColours'
import { getBarcodeReader } from '../lib/barcodeDetector'
import {
  addableItems, bookBodyFromResult, detectMediaTypeId, shouldAccept, upsertItem, withItem,
  type LastAccepted, type ScannedItem,
} from '../lib/scanSession'
import { registerScanTarget } from '../lib/barcodeScanner'
import { openScanCamera } from '../lib/camera'
import { barcodeIdentifier, classifyBarcode, editionForIdentifier, pickCameraScan, savableIdentifier, upcLookupCode, type ScannedIdentifier } from '../lib/barcode'
import { useToast } from './Toast'
import { Icon } from '../lib/icons'
import type { Destination } from '../lib/addBooks'


interface BookFormContributor {
  contributor: ContributorResult | null
  role: string
}

/**
 * What the camera has seen so far in a continuous sweep.
 *
 * Module-level rather than nested in the modal: a component declared inside
 * another is a new type on every render, which would remount the list and
 * lose its scroll position after every single scan.
 */
function ScanSessionList({ items }: { items: ScannedItem[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return null

  const label: Record<ScannedItem['status'], string> = {
    pending:   t('scan.status.pending',   { defaultValue: 'Looking up…' }),
    found:     t('scan.status.found',     { defaultValue: 'Ready' }),
    duplicate: t('scan.status.duplicate', { defaultValue: 'Already shelved' }),
    not_found: t('scan.status.not_found', { defaultValue: 'Not found' }),
    error:     t('scan.status.error',     { defaultValue: 'Failed' }),
    added:     t('scan.status.added',     { defaultValue: 'Added' }),
  }
  // Semantic tokens only, so both themes come for free.
  const tone: Record<ScannedItem['status'], string> = {
    pending:   'text-content-muted',
    found:     'text-content-secondary',
    duplicate: 'text-warning-strong',
    not_found: 'text-content-muted',
    error:     'text-danger',
    added:     'text-success-strong',
  }

  return (
    <ul className="max-h-56 overflow-y-auto rounded-lg border border-line divide-y divide-line">
      {items.map(entry => (
        <li key={entry.code} className="flex items-baseline gap-3 px-3 py-2 text-sm">
          <span className="flex-1 truncate text-content-strong">
            {entry.result?.title || entry.duplicateTitle || entry.code}
          </span>
          <span className={`shrink-0 text-xs ${tone[entry.status]}`}>{label[entry.status]}</span>
        </li>
      ))}
    </ul>
  )
}

interface AddBookModalProps {
  /**
   * Which library the book joins. Optional: opened from Books there is no
   * library in the route, so the modal asks. Every request below is
   * library-scoped, which is why nothing can happen until one is chosen.
   */
  libraryId?: string
  /** Offered when libraryId is absent. */
  libraries?: Library[]
  mediaTypes: MediaType[]
  onClose: () => void
  onSaved: (book: Book) => void
  /** Called when an ISBN scan finds a book already in the library. */
  onDuplicate?: (book: Book) => void
  /** Pre-fill and auto-trigger an ISBN lookup when the modal opens. */
  initialIsbn?: string
  /** Pre-fill the title search and auto-search when there is no ISBN. */
  initialTitle?: string
  /**
   * Hosted inside the Add books dialog, which draws the frame, the
   * destination bar and handles scans: this is only the form, filed at the
   * destination, filled from a lookup or from a scan nobody knew.
   */
  embed?: {
    destination: Destination
    result?: ISBNLookupResult
    identifier?: ScannedIdentifier | null
    /** A barcode from a failed scan, for the ISBN field. */
    barcode?: string
    onLookUp: () => void
    /** The add button, naming where the book goes. */
    addLabel: string
  }
}

export default function AddBookModal({ libraryId: libraryIdProp, libraries, mediaTypes, onClose, onSaved, onDuplicate, initialIsbn, initialTitle, embed }: AddBookModalProps) {
  const libraryId = embed?.destination.libraryId ?? libraryIdProp
  const { callApi } = useAuth()
  const { t } = useTranslation()

  // When the caller supplies no library, the first one is preselected rather
  // than left blank: a modal that refuses to do anything until you notice a
  // dropdown is worse than one that made a reasonable guess you can change.
  const [chosenLibrary, setChosenLibrary] = useState(libraryId ?? libraries?.[0]?.id ?? '')
  const targetLibrary = libraryId ?? chosenLibrary
  useEffect(() => {
    // Embedded, the dialog around the form owns Escape.
    if (embed) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModalRef.current() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [form, setForm] = useState({
    title: '',
    subtitle: '',
    media_type_id: mediaTypes.find(mt => mt.name === 'novel')?.id ?? mediaTypes[0]?.id ?? '',
    description: '',
  })
  const [contributors, setContributors] = useState<BookFormContributor[]>([])
  const [selectedTags, setSelectedTags] = useState<Tag[]>([])
  const [libraryTags, setLibraryTags] = useState<Tag[]>([])
  const [tagQuery, setTagQuery] = useState('')
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false)
  const [newTagColor, setNewTagColor] = useState('#3b82f6')
  const [isCreatingTag, setIsCreatingTag] = useState(false)
  const tagInputRef = useRef<HTMLInputElement>(null)

  const [selectedGenres, setSelectedGenres] = useState<Genre[]>([])
  const [allGenres, setAllGenres] = useState<Genre[]>([])
  // Importing a lookup matches its categories to genres, so it waits for them.
  const [genresLoaded, setGenresLoaded] = useState(false)
  const [genreQuery, setGenreQuery] = useState('')
  const [genreDropdownOpen, setGenreDropdownOpen] = useState(false)
  const genreInputRef = useRef<HTMLInputElement>(null)

  // Series belong to a library, so picking another library drops the rows.
  const [seriesDraft, setSeriesDraft] = useState<{ libraryId: string; rows: SeriesRowDraft[] }>({ libraryId: '', rows: [] })
  const seriesRows = seriesDraft.libraryId === targetLibrary ? seriesDraft.rows : []
  const setSeriesRows = (rows: SeriesRowDraft[]) => setSeriesDraft({ libraryId: targetLibrary, rows })

  useEffect(() => {
    callApi<Tag[]>(`/api/v1/libraries/${targetLibrary}/tags`)
      .then(ts => setLibraryTags(ts ?? []))
      .catch(() => {})
    callApi<Genre[]>('/api/v1/genres')
      .then(gs => setAllGenres(gs ?? []))
      .catch(() => {})
      .finally(() => setGenresLoaded(true))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLibrary])

  const [allShelves, setAllShelves] = useState<SavedList[]>([])
  const [selectedShelfIds, setSelectedShelfIds] = useState<Set<string>>(
    () => new Set(embed?.destination.listId ? [embed.destination.listId] : []))

  // Not scoped to the target library: a list's membership is (list, book) with
  // no library in it, and the shelf route this replaced could not see a
  // private list at all.
  useEffect(() => {
    void fetchLists(callApi)
      .then(all => setAllShelves(all.filter(l => l.kind === 'manual')))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Edition section — open by default when adding a new book
  const [showEdition, setShowEdition] = useState(true)
  const [edition, setEdition] = useState({
    format: 'paperback',
    edition_name: '',
    language: '',
    publisher: '',
    publish_date: '',
    isbn_10: '',
    // A scan nobody knew: saved on the edition, so it's found next time.
    isbn_13: embed?.barcode && classifyBarcode(embed.barcode).kind === 'isbn' ? embed.barcode : '',
    page_count: '',
    duration_hours: '',
    duration_minutes: '',
    narrator: '',
    is_primary: true,
  })

  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [pendingCoverUrl, setPendingCoverUrl] = useState<string | null>(null)

  // ─── ISBN lookup mode ──────────────────────────────────────────────────────
  const [mode, setMode] = useState<'isbn' | 'search' | 'manual'>(embed ? 'manual' : !initialIsbn && initialTitle ? 'search' : 'isbn')
  const [isbnInput, setIsbnInput] = useState(initialIsbn ?? '')
  const [isbnMerged, setIsbnMerged] = useState<MergedBookResult | null>(null)
  // The last lookup was by UPC, whose answers need checking; see below.
  const [mergedFromUpc, setMergedFromUpc] = useState(false)
  // The scanned code the showing lookup came from, and, once its result is
  // used, the code the new edition gets saved under so the next scan finds it.
  const [mergedIdentifier, setMergedIdentifier] = useState<ScannedIdentifier | null>(null)
  const [saveIdentifier, setSaveIdentifier] = useState<ScannedIdentifier | null>(() => {
    // A UPC nobody knew is kept on the edition like an ISBN would be.
    if (!embed?.barcode || embed.result) return null
    const b = classifyBarcode(embed.barcode)
    return b.kind === 'isbn' ? null : savableIdentifier(b)
  })
  const [isbnLoading, setIsbnLoading] = useState(false)
  const [isbnError, setIsbnError] = useState<string | null>(null)
  const [isbnDuplicate, setIsbnDuplicate] = useState<Book | null>(null)
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const isbnInputRef = useRef<HTMLInputElement>(null)

  // ─── Continuous scan session ───────────────────────────────────────────────
  // Sweeping a shelf rather than adding one book: the camera stays on and each
  // ISBN it sees joins this list, which the user reviews before anything is
  // written. Kept apart from the single-book form state on purpose — see
  // lookupScanned for why.
  const [scanned, setScanned] = useState<ScannedItem[]>([])
  const [addingScanned, setAddingScanned] = useState(false)
  const [lastScanSaved, setLastScanSaved] = useState<Book | null>(null)
  // The detection loop is a closure created once per scan, so it cannot read
  // React state. These refs are what it looks at instead.
  const continuousRef = useRef(false)
  const lastAcceptedRef = useRef<LastAccepted | null>(null)
  const scannedRef = useRef<ScannedItem[]>([])
  useEffect(() => { scannedRef.current = scanned }, [scanned])

  // ─── Freetext book search mode ─────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState((!initialIsbn && initialTitle) ? initialTitle : '')
  const [searchResults, setSearchResults] = useState<ISBNLookupResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchProgress, setSearchProgress] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!searchLoading) { setSearchProgress(0); return }
    setSearchProgress(0)
    let current = 0
    let tid: ReturnType<typeof setTimeout>
    const step = () => {
      const remaining = 90 - current
      if (remaining < 1) return
      current = Math.min(current + (Math.random() * 0.18 + 0.04) * remaining, 90)
      setSearchProgress(Math.round(current))
      tid = setTimeout(step, 300 + Math.random() * 900)
    }
    tid = setTimeout(step, 120)
    return () => clearTimeout(tid)
  }, [searchLoading])

  const doBookSearch = async (query: string) => {
    if (!query.trim()) return
    setSearchLoading(true)
    setSearchError(null)
    setSearchResults([])
    try {
      const results = await callApi<ISBNLookupResult[]>(`/api/v1/lookup/books?q=${encodeURIComponent(query.trim())}`)
      setSearchResults(results ?? [])
      if (!results || results.length === 0) setSearchError('No results found.')
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Unable to retrieve results — please try again later.')
    } finally {
      setSearchLoading(false)
    }
  }

  const stopScan = () => {
    setScanning(false)
    continuousRef.current = false
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  const startScan = async (continuous = false) => {
    setIsbnError(null)
    // The session is NOT cleared here. "Scan more" resumes a sweep, and
    // wiping the list on resume would throw away reviewed rows, rows already
    // added, and any lookup still in flight. Starting fresh is the job of
    // whoever opens a new session — see resetScanSession.
    continuousRef.current = continuous
    lastAcceptedRef.current = null
    try {
      const stream = await openScanCamera()
      streamRef.current = stream
      setScanning(true)
      // Give React time to render the video element
      setTimeout(async () => {
        if (!videoRef.current) return
        // This callback runs after the try/catch below has already returned,
        // so it needs its own. Getting the detector can now fail on its own
        // terms — the fallback is a dynamically imported chunk, and fetching
        // it fails on a flaky connection, or on a page left open across a
        // deployment that invalidated its asset URLs. Without this the
        // rejection goes nowhere: the camera stays on and the modal sits in
        // scanning mode with nothing to show for it.
        let detector: Awaited<ReturnType<typeof getBarcodeReader>>
        try {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
          // zxing on every browser, so a paperback's add-on is read too.
          // See lib/barcodeDetector.
          detector = await getBarcodeReader()
        } catch {
          stopScan()
          setIsbnError(t('scan.start_failed', {
            defaultValue: 'Could not start the barcode scanner.',
          }))
          return
        }
        // When a bare UPC was first seen, while the camera waits for its add-on.
        let bareSince: number | null = null
        const scan = async () => {
          if (!videoRef.current || !streamRef.current) return
          try {
            const codes = await detector.detect(videoRef.current)
            if (codes.length > 0) {
              if (!continuousRef.current) {
                const now = performance.now()
                const code = pickCameraScan(codes.map(c => c.rawValue), bareSince, now)
                if (code === null) {
                  bareSince ??= now
                } else {
                  stopScan()
                  setIsbnInput(code)
                  doISBNLookup(code)
                  return
                }
                requestAnimationFrame(scan)
                return
              }
              // Continuous mode: the camera stays on and the code joins the
              // session. shouldAccept filters the price barcode beside the
              // ISBN one, codes already queued, and the repeat fires that a
              // book held steady in frame produces on every animation frame.
              // Every code in the frame is considered, not just the first.
              // A back cover often shows the price barcode beside the ISBN
              // one, and if the detector happens to return the price code
              // first, looking only at codes[0] would reject the frame and
              // never reach the ISBN sitting right behind it.
              for (const detected of codes) {
                if (acceptIntoSession(detected.rawValue)) break
              }
            }
          } catch {
            // A detect() failure is transient — a frame arriving mid-resize,
            // say. Keep the loop alive rather than dropping the session.
          }
          requestAnimationFrame(scan)
        }
        scan()
      }, 100)
    } catch {
      setIsbnError(t('scan.camera_denied', { defaultValue: 'Camera access denied or unavailable.' }))
    }
  }

  /**
   * Resolve one scanned code without disturbing the single-book form.
   *
   * The form state machine is driven by importResult, which fills a dozen
   * fields and resolves contributors over the network. Reusing it here would
   * mean the last scan of a sweep silently decided what the form contained,
   * so the session keeps its own lightweight record instead.
   */
  /**
   * Take one code into the sweep, if the session's rules allow it: a book
   * barcode, not already listed, not the code just accepted. Shared by the
   * camera loop and a hardware scanner, so both follow the same rules.
   */
  function acceptIntoSession(code: string): boolean {
    if (!shouldAccept(code, scannedRef.current, lastAcceptedRef.current, Date.now())) return false
    lastAcceptedRef.current = { code, at: Date.now() }
    setScanned(prev => upsertItem(prev, { code, status: 'pending' }))
    void lookupScanned(code)
    return true
  }

  async function lookupScanned(code: string) {
    try {
      // The merged lookup, like the single-book path: each field is the value
      // most providers agree on, not whichever provider answered first.
      const [merged, duplicate] = await Promise.all([
        callApi<MergedBookResult>(`/api/v1/lookup/isbn/${encodeURIComponent(code)}/merged`),
        callApi<Book>(`/api/v1/libraries/${targetLibrary}/book-by-isbn/${encodeURIComponent(code)}`).catch(() => null),
      ])
      if (duplicate) {
        setScanned(prev => withItem(prev, code, { status: 'duplicate', duplicateTitle: duplicate.title }))
        return
      }
      setScanned(prev => withItem(prev, code, hasAnyField(merged)
        ? { status: 'found', result: mergedToResult(merged!, {}) }
        : { status: 'not_found' }))
    } catch {
      setScanned(prev => withItem(prev, code, { status: 'error' }))
    }
  }

  /**
   * Add every looked-up scan, one request at a time so failures stay isolated.
   *
   * onSaved is deliberately NOT called per book: callers treat it as "the
   * modal is finished" and close it, which would end the sweep after the
   * first success. The last created book is held instead and handed over
   * once, when the user closes the session.
   */
  async function addScannedBooks() {
    setAddingScanned(true)
    let last: Book | null = null
    try {
      for (const entry of addableItems(scanned)) {
        try {
          const book = await callApi<Book>(`/api/v1/libraries/${targetLibrary}/books`, {
            method: 'POST',
            body: JSON.stringify(bookBodyFromResult(entry.result!, mediaTypes)),
          })
          if (entry.result!.cover_url) {
            // Best-effort, exactly as the single-book path treats it.
            callApi(`/api/v1/libraries/${targetLibrary}/books/${book!.id}/cover/fetch`, {
              method: 'POST',
              body: JSON.stringify({ url: entry.result!.cover_url }),
            }).catch(() => {})
          }
          last = book
          setScanned(prev => withItem(prev, entry.code, { status: 'added', bookId: book!.id }))
        } catch {
          setScanned(prev => withItem(prev, entry.code, { status: 'error' }))
        }
      }
      if (last) setLastScanSaved(last)
    } finally {
      setAddingScanned(false)
    }
  }

  /**
   * Close the modal, telling the caller to refresh if a sweep created anything.
   *
   * Every exit has to go through here, not just the sweep's own Done button:
   * Escape, the backdrop, the header X and the footer Cancel all used to call
   * onClose directly, and callers like BooksPage only reload on onSaved. Books
   * created by a sweep would then stay invisible until some later refresh —
   * they were saved, but the shelf did not show them.
   */
  const closeModal = () => {
    stopScan()
    if (lastScanSaved) onSaved(lastScanSaved)
    else onClose()
  }

  /** Clear a finished session so the next sweep starts from nothing. */
  const resetScanSession = () => {
    setScanned([])
    setLastScanSaved(null)
    lastAcceptedRef.current = null
  }

  // The Escape listener is bound once, so it would otherwise close over the
  // first render's closeModal and never see a book the sweep saved later.
  const closeModalRef = useRef(closeModal)
  closeModalRef.current = closeModal

  // Embedded with a lookup: fill the form from it, once genres are in so its
  // categories can match them.
  const imported = useRef(false)
  useEffect(() => {
    if (!embed?.result || !genresLoaded || imported.current) return
    imported.current = true
    void importResult(embed.result, embed.identifier ?? null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genresLoaded])

  // Auto-trigger lookup when modal opens with a pre-filled ISBN or title
  useEffect(() => {
    if (embed) return
    if (initialIsbn) doISBNLookup(initialIsbn)
    else if (initialTitle) doBookSearch(initialTitle)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // While open, this modal takes hardware scanner scans itself, so a scan
  // replaces the ISBN here instead of opening a second Add Book on top.
  const toast = useToast()
  const lookupRef = useRef(doISBNLookup)
  const sweepRef = useRef(acceptIntoSession)
  useEffect(() => { lookupRef.current = doISBNLookup; sweepRef.current = acceptIntoSession })
  const embedded = !!embed
  useEffect(() => embedded ? undefined : registerScanTarget(barcode => {
    // The global scanner turns away anything that isn't a barcode first.
    if (barcode.kind === 'invalid') return
    if (barcode.kind !== 'isbn') {
      const code = upcLookupCode(barcode)
      // A sweep collects ISBNs to look up later; a UPC is looked up on its own.
      if (continuousRef.current || scannedRef.current.length > 0) {
        toast.show(t('scanner.upc_not_in_sweep', { code, defaultValue: `Scan a UPC on its own, not in a sweep: ${code}` }), { variant: 'error' })
        return
      }
      setMode('isbn')
      setIsbnInput(code)
      lookupRef.current(code)
      return
    }
    // A sweep is running, with the camera on or its list under review: the
    // scan joins the list, the same as a camera scan would, rather than going
    // to the single-book form hidden behind it.
    if (continuousRef.current || scannedRef.current.length > 0) {
      sweepRef.current(barcode.isbn13)
      return
    }
    setMode('isbn')
    setIsbnInput(barcode.isbn13)
    lookupRef.current(barcode.isbn13)
  }), [embedded, t, toast])

  // Focus the relevant input whenever the active mode changes (and when a
  // barcode scan is cancelled, which remounts the ISBN input).
  useEffect(() => {
    if (mode === 'isbn') {
      if (!scanning) isbnInputRef.current?.focus()
    } else if (mode === 'search') {
      searchInputRef.current?.focus()
    } else if (mode === 'manual') {
      titleInputRef.current?.focus()
    }
  }, [mode, scanning])

  // Function declaration, not a const arrow: the barcode-scan callback above
  // and the auto-trigger effect both call this before this line is reached.
  // A hoisted declaration has no temporal dead zone and no stale-closure
  // hazard, since the binding never gets reassigned.
  // A back cover scanned with its add-on that the server couldn't turn into
  // an ISBN. If the next lookup here is that book's ISBN, the server can learn
  // the publisher from the pair; it checks the add-on matches, so a pair that
  // isn't the same book is refused and nothing is kept.
  const unresolvedUpcRef = useRef<string | null>(null)
  // What the last lookup asked for, for Ask again.
  const lastLookupRef = useRef('')

  async function learnFromPair(upc: string, isbn13: string) {
    try {
      const r = await callApi<{ added: boolean }>('/api/v1/lookup/upc/learn', {
        method: 'POST',
        body: JSON.stringify({ upc, isbn: isbn13 }),
      })
      if (r?.added) {
        toast.show(t('add_book.learned', { defaultValue: "Got it. This publisher's paperbacks will now be found from the back cover." }))
      }
    } catch { /* not the same book, or the server is older: nothing to learn */ }
  }

  /**
   * Make sure a scanned code ended up on the book just added. When the ISBN
   * matched an edition the server already had, it reuses that edition and
   * drops the identifiers sent with the new one, so this adds it there. The
   * usual 409 means it's already saved. Any failure is ignored: the book is
   * added either way, and only the next scan's shortcut is lost.
   */
  async function attachIdentifier(bookId: string, id: ScannedIdentifier, isbn13: string) {
    try {
      const editions = await callApi<BookEdition[]>(`/api/v1/libraries/${targetLibrary}/books/${bookId}/editions`)
      const target = editionForIdentifier(editions ?? [], isbn13)
      if (!target) return
      await callApi(`/api/v1/editions/${target.id}/identifiers`, {
        method: 'POST',
        body: JSON.stringify(id),
      })
    } catch { /* already saved, held by another edition, or an older server */ }
  }

  async function doISBNLookup(isbn: string) {
    if (!isbn.trim()) return
    lastLookupRef.current = isbn.trim()
    // Select what was looked up, so the next scan into the box replaces it
    // rather than landing on the end: a second scan of the same book, to
    // catch the add-on the first one missed, used to give 30 digits.
    const box = isbnInputRef.current
    if (box && document.activeElement === box) box.select()
    setIsbnLoading(true)
    setIsbnError(null)
    setIsbnMerged(null)
    setMergedIdentifier(null)
    setIsbnDuplicate(null)
    const cleanISBN = isbn.trim()
    const barcode = classifyBarcode(cleanISBN)
    const upc = barcode.kind === 'upc' || barcode.kind === 'ean' ? upcLookupCode(barcode) : null
    const scannedId = barcodeIdentifier(barcode)
    if (barcode.kind === 'isbn' && unresolvedUpcRef.current) {
      void learnFromPair(unresolvedUpcRef.current, barcode.isbn13)
    }
    unresolvedUpcRef.current = null
    try {
      // One merged answer across every provider that's on, each field
      // pre-selected by the server; MergedLookup lets the person switch any.
      // A UPC asks the providers that read UPCs, and skips the duplicate
      // check, which only knows ISBNs.
      const [merged, duplicate] = await Promise.all([
        upc
          ? callApi<MergedBookResult>(`/api/v1/lookup/upc/${encodeURIComponent(upc)}/merged`)
          : callApi<MergedBookResult>(`/api/v1/lookup/isbn/${encodeURIComponent(cleanISBN)}/merged`),
        upc
          ? Promise.resolve(null)
          : callApi<Book>(`/api/v1/libraries/${targetLibrary}/book-by-isbn/${encodeURIComponent(cleanISBN)}`).catch(() => null),
      ]).then(async ([m, d]) => {
        // The server found the ISBN in the add-on, so the duplicate check
        // can run after all.
        if (upc && m?.from_isbn) {
          d = await callApi<Book>(`/api/v1/libraries/${targetLibrary}/book-by-isbn/${encodeURIComponent(m.from_isbn)}`).catch(() => null)
        } else if (scannedId) {
          // Otherwise the code itself may be on a book here already, saved
          // when that book was added from this same scan.
          d = await callApi<Book>(`/api/v1/libraries/${targetLibrary}/book-by-identifier?type=${scannedId.scheme}&value=${encodeURIComponent(scannedId.value)}`).catch(() => null)
        }
        return [m, d] as const
      })
      setIsbnDuplicate(duplicate ?? null)
      if (duplicate) onDuplicate?.(duplicate)
      if (upc && (barcode.kind === 'upc' || barcode.kind === 'ean') && barcode.addon && !merged?.from_isbn) {
        unresolvedUpcRef.current = upc
      }
      if (hasAnyField(merged)) {
        setIsbnMerged(merged)
        setMergedIdentifier(savableIdentifier(barcode))
        // Found through the add-on's ISBN, it's as sure as an ISBN lookup.
        setMergedFromUpc(!!upc && !merged.from_isbn)
      } else {
        setIsbnError(upc
          ? t('merged.none_upc', { defaultValue: 'No results found for that UPC.' })
          : t('merged.none', { defaultValue: 'No results found for that ISBN.' }))
      }
    } catch (err) {
      setIsbnError(err instanceof ApiError ? err.message : 'Lookup failed')
    } finally {
      setIsbnLoading(false)
    }
  }

  // identifier is the scanned code the result was looked up by, if any; a
  // result from a title search has none, so it clears one left from before.
  const importResult = async (result: ISBNLookupResult, identifier: ScannedIdentifier | null = null) => {
    setSaveIdentifier(identifier)
    // Media type detection is shared with the sweep rather than written twice.
    // The heuristic itself is not new — it lived here — but two copies of it
    // would drift, and a book added by sweeping should land on the same type
    // it would have had when added one at a time.
    const detectedTypeId = detectMediaTypeId(result, mediaTypes)

    // Extract "Vol. N" from title into subtitle when subtitle is absent
    let title = result.title || ''
    let subtitle = result.subtitle || ''
    if (!subtitle && title) {
      const volMatch = title.match(/,?\s*(Vol(?:ume)?\.?\s*\d+(?:\.\d+)?)$/i)
      if (volMatch) {
        subtitle = volMatch[1].trim()
        title = title.slice(0, title.length - volMatch[0].length).trim()
      }
    }

    // Fill book-level fields (no ISBN/publisher/date on book any more)
    setForm(f => ({
      ...f,
      title: title || f.title,
      subtitle: subtitle || f.subtitle,
      description: result.description || f.description,
      media_type_id: detectedTypeId ?? f.media_type_id,
    }))

    // Fill edition-level fields (ISBN, publisher, date, language live here)
    setEdition(e => ({
      ...e,
      language:     result.language     || e.language,
      publisher:    result.publisher    || e.publisher,
      publish_date: result.publish_date || e.publish_date,
      isbn_10:      result.isbn_10      || e.isbn_10,
      isbn_13:      result.isbn_13      || e.isbn_13,
      page_count:   result.page_count != null ? String(result.page_count) : e.page_count,
    }))
    setShowEdition(true)

    // Auto-populate contributors (search for existing, create if missing)
    if (result.authors && result.authors.length > 0) {
      const imported: BookFormContributor[] = []
      for (const rawName of result.authors) {
        // Strip "(Role)" suffix if it matches a known contributor role.
        // e.g. "Giancarlo Carracuzzo (Illustrator)" → name="Giancarlo Carracuzzo", role="illustrator"
        let name = rawName
        let role = 'author'
        const parenMatch = rawName.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
        if (parenMatch) {
          const candidate = parenMatch[2].toLowerCase()
          if (CONTRIBUTOR_ROLES.includes(candidate)) {
            name = parenMatch[1].trim()
            role = candidate
          }
        }
        try {
          const matches = await callApi<ContributorResult[]>(
            `/api/v1/contributors?q=${encodeURIComponent(name)}`
          )
          const exact = (matches ?? []).find(
            c => c.name.toLowerCase() === name.toLowerCase()
          )
          if (exact) {
            imported.push({ contributor: exact, role })
          } else {
            const created = await callApi<ContributorResult>('/api/v1/contributors', {
              method: 'POST',
              body: JSON.stringify({ name }),
            })
            if (created) imported.push({ contributor: created, role })
          }
        } catch { /* skip this contributor on error */ }
      }
      if (imported.length > 0) {
        // Deduplicate by (contributor.id, role) in case the provider returned
        // the same author name more than once.
        const seen = new Set<string>()
        setContributors(imported.filter(c => {
          const key = `${c.contributor!.id}:${c.role}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }))
      }
    }

    if (result.cover_url) setPendingCoverUrl(result.cover_url)

    // Match provider categories against instance genres
    const resultCategories = result.categories ?? []
    if (resultCategories.length > 0 && allGenres.length > 0) {
      const matched = allGenres.filter(g =>
        resultCategories.some(c => c.toLowerCase() === g.name.toLowerCase())
      )
      if (matched.length > 0) setSelectedGenres(matched)
    }

    setMode('manual')
  }

  // When ISBN is entered, suggest physical edition automatically
  const isbnEntered = edition.isbn_10 || edition.isbn_13

  const createTag = async (name: string) => {
    if (!name.trim() || isCreatingTag) return
    setIsCreatingTag(true)
    try {
      const tag = await callApi<Tag>(`/api/v1/libraries/${targetLibrary}/tags`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), color: newTagColor }),
      })
      if (tag) {
        setLibraryTags(ts => [...ts, tag])
        setSelectedTags(ts => [...ts, tag])
      }
      setTagQuery('')
      setTagDropdownOpen(false)
    } catch { /* ignore */ }
    finally { setIsCreatingTag(false) }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setIsLoading(true)
    try {
      const body: Record<string, unknown> = {
        ...form,
        contributors: contributors
          .filter(c => c.contributor !== null)
          .map((c, i) => ({ contributor_id: c.contributor!.id, role: c.role, display_order: i }))
          // Deduplicate by (contributor_id, role) — providers can return the same
          // author name twice, which resolves to the same contributor ID.
          .filter((c, idx, arr) =>
            arr.findIndex(x => x.contributor_id === c.contributor_id && x.role === c.role) === idx
          ),
        tag_ids: selectedTags.map(t => t.id),
        genre_ids: selectedGenres.map(g => g.id),
      }
      if (embed?.destination.locationId) body.location_id = embed.destination.locationId
      if (showEdition) {
        const isAudio = edition.format === 'audiobook'
        const isPhysical = !isAudio && edition.format !== 'ebook' && edition.format !== 'digital'
        const durationSecs = isAudio
          ? ((Number(edition.duration_hours) || 0) * 3600) + ((Number(edition.duration_minutes) || 0) * 60)
          : null
        body.edition = {
          format:           edition.format,
          edition_name:     edition.edition_name,
          language:         edition.language,
          publisher:        edition.publisher,
          publish_date:     edition.publish_date,
          isbn_10:          isPhysical ? edition.isbn_10 : null,
          isbn_13:          !isAudio ? edition.isbn_13 : null,
          page_count:       !isAudio && edition.page_count ? Number(edition.page_count) : null,
          duration_seconds: durationSecs || null,
          narrator:         isAudio ? edition.narrator : null,
          is_primary:       edition.is_primary,
          // Saved with the new edition in the same transaction. The server
          // also reuses an edition that already holds it, so the same comic
          // scanned into a second library isn't added twice.
          ...(saveIdentifier ? { identifiers: [saveIdentifier] } : {}),
        }
      }
      const postBook = () => callApi<Book>(`/api/v1/libraries/${targetLibrary}/books`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      let book: Book
      try {
        book = await postBook()
      } catch (err) {
        // The identifier is refused as a whole add: 409 if another edition
        // took it meanwhile, 400 for a scheme the server lacks. The book
        // matters more than the scan shortcut, so add it without.
        const sent = body.edition as Record<string, unknown> | undefined
        if (!(err instanceof ApiError && (err.status === 409 || err.status === 400) && sent?.identifiers)) throw err
        delete sent.identifiers
        book = await postBook()
      }

      // Fetch cover from provider result (best-effort)
      const bookId = book!.id
      if (pendingCoverUrl) {
        callApi(`/api/v1/libraries/${targetLibrary}/books/${bookId}/cover/fetch`, {
          method: 'POST',
          body: JSON.stringify({ url: pendingCoverUrl }),
        }).catch(() => {})
      }

      if (showEdition && saveIdentifier) await attachIdentifier(bookId, saveIdentifier, edition.format === 'audiobook' ? '' : edition.isbn_13)

      // Apply list membership
      for (const id of selectedShelfIds)
        await callApi(`/api/v1/me/lists/${id}/books/${bookId}`, { method: 'POST' }).catch(() => {})
      // The create route takes no series, so they go on once the book exists.
      await saveSeriesRows(callApi, targetLibrary, bookId, seriesRows, new Map())
      if (embed && embed.destination.readStatus !== 'unread') {
        await callApi(`/api/v1/books/${bookId}/me`, {
          method: 'PUT',
          body: JSON.stringify({ read_status: embed.destination.readStatus }),
        }).catch(() => {})
      }

      onSaved(book)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save book')
    } finally { setIsLoading(false) }
  }

  const inputCls = 'w-full rounded-lg border border-line-strong dark:bg-gray-800 dark:text-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
  const labelCls = 'block text-xs font-semibold uppercase tracking-wider text-content-muted mb-1.5'

  const filteredTags = libraryTags.filter(t =>
    !selectedTags.some(s => s.id === t.id) &&
    t.name.toLowerCase().includes(tagQuery.toLowerCase())
  )
  const filteredGenres = allGenres.filter(g =>
    !selectedGenres.some(s => s.id === g.id) &&
    g.name.toLowerCase().includes(genreQuery.toLowerCase())
  )
  const tagQueryMatchesExisting = libraryTags.some(t => t.name.toLowerCase() === tagQuery.trim().toLowerCase())

  const body = (
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {mode === 'isbn' ? (
            <div className="space-y-4">
              {scanning ? (
                <div className="space-y-3">
                  <p className="text-sm text-content-tertiary">
                    {continuousRef.current
                      ? t('scan.sweep_hint', {
                          defaultValue: 'Keep scanning — each book joins the list below.',
                        })
                      : t('scan.hint', { defaultValue: 'Point your camera at a barcode…' })}
                  </p>
                  <video ref={videoRef} className="w-full rounded-lg bg-black aspect-video object-cover" playsInline />
                  {continuousRef.current && <ScanSessionList items={scanned} />}
                  <button type="button" onClick={stopScan}
                    className="w-full rounded-lg border border-line-strong py-2 text-sm font-medium text-content-secondary hover:bg-surface-muted transition-colors">
                    {t('scan.stop', { defaultValue: 'Stop scanning' })}
                  </button>
                </div>
              ) : scanned.length > 0 ? (
                // The sweep is over but the session is still on screen: the
                // user reviews what was found before anything is written.
                <div className="space-y-3">
                  <ScanSessionList items={scanned} />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void addScannedBooks()}
                      disabled={addingScanned || addableItems(scanned).length === 0}
                      className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                      {addingScanned
                        ? t('scan.adding', { defaultValue: 'Adding…' })
                        : t('scan.add_all', {
                            count: addableItems(scanned).length,
                            defaultValue: 'Add {{count}} books',
                          })}
                    </button>
                    <button type="button" onClick={() => void startScan(true)} disabled={addingScanned}
                      className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-content-secondary hover:bg-surface-muted disabled:opacity-50 transition-colors">
                      {t('scan.resume', { defaultValue: 'Scan more' })}
                    </button>
                    <button type="button" onClick={closeModal} disabled={addingScanned}
                      className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-content-secondary hover:bg-surface-muted disabled:opacity-50 transition-colors">
                      {t('scan.done', { defaultValue: 'Done' })}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input type="text" value={isbnInput}
                      ref={isbnInputRef}
                      onChange={e => setIsbnInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && doISBNLookup(isbnInput)}
                      placeholder={t('add_book.isbn_or_upc', { defaultValue: 'ISBN or UPC…' })}
                      className={inputCls} />
                    <button type="button" onClick={() => doISBNLookup(isbnInput)} disabled={isbnLoading || !isbnInput.trim()}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                      {isbnLoading ? '…' : 'Search'}
                    </button>
                    <button type="button" onClick={() => void startScan(false)}
                      className="rounded-lg border border-line-strong px-3 py-2 text-sm text-content-tertiary hover:bg-surface-muted transition-colors"
                      title={t('scan.one', { defaultValue: 'Scan barcode' })}>📷</button>
                    {/* Sweeping a shelf is a different act from adding one
                        book, so it gets its own entry point rather than a
                        mode toggle hidden inside the camera view. */}
                    <button type="button" onClick={() => { resetScanSession(); void startScan(true) }}
                      className="rounded-lg border border-line-strong px-3 py-2 text-sm text-content-tertiary hover:bg-surface-muted transition-colors"
                      title={t('scan.many', { defaultValue: 'Scan several books in a row' })}>📚</button>
                  </div>
                  {isbnError && (
                    <p className="flex flex-wrap items-center gap-x-3 text-sm text-danger">
                      {isbnError}
                      {/* A provider blips now and then; asking again is cheaper
                          than retyping. */}
                      <button type="button" className="text-accent hover:underline" disabled={isbnLoading}
                        onClick={() => void doISBNLookup(lastLookupRef.current)}>
                        {t('add_book.ask_again', { defaultValue: 'Ask again' })}
                      </button>
                    </p>
                  )}
                  {isbnLoading && <p className="text-sm text-content-muted">Searching providers…</p>}
                  {isbnDuplicate && (
                    <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-warning-surface px-4 py-3 text-sm">
                      <p className="font-medium text-warning-strong">Already in your library</p>
                      <p className="mt-0.5 text-warning-strong truncate">{isbnDuplicate.title}</p>
                      <div className="mt-2 flex gap-3">
                        <Link to={`/libraries/${libraryId}/books/${isbnDuplicate.id}`}
                          className="text-warning-strong font-medium underline hover:no-underline" onClick={onClose}>
                          View existing →
                        </Link>
                        <span className="text-amber-600 dark:text-amber-500">or import to add an edition</span>
                      </div>
                    </div>
                  )}
                  {isbnMerged && mergedFromUpc && (
                    // A paperback's UPC names the publisher and the price, and
                    // every book at that price shares it, so the answer can be
                    // a different book entirely (Tor's
                    // 037145007991 came back as another author's novel).
                    <p className="mb-3 rounded-lg border border-warning-line bg-warning-surface px-3 py-2 text-[13px] text-warning-strong">
                      {t('add_book.upc_warning', { defaultValue: "Looked up by UPC. Paperbacks often share one UPC with every book at the same price, so check this is your book. The ISBN, printed near the barcode or on the copyright page, finds it for sure." })}
                    </p>
                  )}
                  {isbnMerged?.from_isbn && (
                    <p className="mb-3 text-[13px] text-content-muted">
                      {t('add_book.from_isbn', { isbn: isbnMerged.from_isbn, defaultValue: 'Found by ISBN {{isbn}}, worked out from the small barcode beside the UPC.' })}
                    </p>
                  )}
                  {(isbnMerged?.other_isbns?.length ?? 0) > 0 && (
                    // The publisher has more than one ISBN prefix and the
                    // add-on is a real book under each: say so, don't guess.
                    <div className="mb-3 rounded-lg border border-warning-line bg-warning-surface px-3 py-2 text-[13px] text-warning-strong">
                      {t('add_book.other_isbns', { defaultValue: 'That barcode could also be:' })}
                      <ul className="mt-1 space-y-0.5">
                        {isbnMerged!.other_isbns!.map(o => (
                          <li key={o.isbn}>
                            <button type="button" className="underline hover:no-underline"
                              onClick={() => { setIsbnInput(o.isbn); void doISBNLookup(o.isbn) }}>
                              {o.title || o.isbn}
                            </button>
                            <span className="ml-1 text-content-muted">{o.isbn}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {isbnMerged && (
                    <MergedLookup key={isbnInput} merged={isbnMerged} onUse={r => { void importResult(r, mergedIdentifier) }}
                      onRetry={isbnLoading ? undefined : () => void doISBNLookup(lastLookupRef.current)} />
                  )}
                  <button type="button" onClick={() => setMode('manual')}
                    className="text-sm text-accent hover:underline">
                    Add manually instead →
                  </button>
                </>
              )}
            </div>
          ) : mode === 'search' ? (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input type="text" value={searchInput}
                  ref={searchInputRef}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && doBookSearch(searchInput)}
                  placeholder="Search by title, author, or keyword…"
                  className={inputCls} />
                <button type="button" onClick={() => doBookSearch(searchInput)} disabled={searchLoading || !searchInput.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {searchLoading ? '…' : 'Search'}
                </button>
              </div>
              {searchError && <p className="text-sm text-danger">{searchError}</p>}
              {searchLoading && (
                <div>
                  <div className="h-1.5 w-full rounded-full bg-surface-inset overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500"
                      style={{
                        width: `${searchProgress}%`,
                        transition: searchProgress > 0 ? 'width 0.4s ease-out' : 'none',
                      }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-content-subtle">Searching providers…</p>
                </div>
              )}
              {searchResults.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
                    {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                  </p>
                  {searchResults.map((r, i) => (
                    <button key={i} type="button"
                      onClick={async () => { await importResult(r); setMode('manual') }}
                      className="w-full text-left rounded-xl border border-line bg-surface-muted p-3 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-accent-surface transition-colors">
                      <div className="flex gap-3">
                        {r.cover_url ? (
                          <img src={r.cover_url} alt="" referrerPolicy="no-referrer" className="w-10 h-14 object-cover rounded flex-shrink-0 bg-surface-strong" />
                        ) : (
                          <div className="w-10 h-14 rounded flex-shrink-0 bg-surface-strong" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-content truncate">{r.title}</p>
                          {r.subtitle && <p className="text-xs text-content-muted truncate">{r.subtitle}</p>}
                          {r.authors?.length > 0 && <p className="text-xs text-content-tertiary mt-0.5 truncate">{r.authors.join(', ')}</p>}
                          <div className="flex items-center gap-2 mt-1">
                            {r.publish_date && <span className="text-xs text-content-subtle">{r.publish_date.slice(0, 4)}</span>}
                            {r.publish_date && <span className="text-content-faint">·</span>}
                            <span className="text-xs text-content-subtle">{r.provider_display}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => setMode('manual')}
                className="text-sm text-accent hover:underline">
                Add manually instead →
              </button>
            </div>
          ) : (
          <form id="book-form" onSubmit={handleSubmit} className="space-y-5">

            {/* Title + Subtitle */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Title <span className="text-red-500 normal-case tracking-normal font-normal">*</span></label>
                <input type="text" value={form.title} ref={titleInputRef} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Attack on Titan" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Subtitle</label>
                <input type="text" value={form.subtitle} onChange={e => setForm(f => ({ ...f, subtitle: e.target.value }))}
                  placeholder="e.g. Vol. 15" className={inputCls} />
              </div>
            </div>

            {/* Media type */}
            <div>
              <label className={labelCls}>Media type <span className="text-red-500 normal-case tracking-normal font-normal">*</span></label>
              <MediaTypeSelect
                value={form.media_type_id}
                mediaTypes={mediaTypes}
                onChange={id => setForm(f => ({ ...f, media_type_id: id }))}
              />
            </div>

            {/* Description */}
            <div>
              <label className={labelCls}>Description</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={4} className={`${inputCls} resize-none`} />
            </div>

            {/* Contributors */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={labelCls}>Contributors</label>
                <button type="button"
                  onClick={() => setContributors(cs => [...cs, { contributor: null, role: 'author' }])}
                  className="text-xs text-accent hover:underline">+ Add</button>
              </div>
              <div className="space-y-2">
                {contributors.map((c, i) => (
                  <ContributorRow key={i}
                    contributor={c.contributor} role={c.role}
                    onContributorChange={contributor => setContributors(cs => cs.map((x, j) => j === i ? { ...x, contributor } : x))}
                    onRoleChange={role => setContributors(cs => cs.map((x, j) => j === i ? { ...x, role } : x))}
                    onRemove={() => setContributors(cs => cs.filter((_, j) => j !== i))}
                    onJoinAbove={i > 0 ? () => void joinWithAbove(callApi, contributors, i).then(setContributors) : undefined} />
                ))}
                {contributors.length === 0 && (
                  <p className="text-xs text-content-subtle">No contributors added.</p>
                )}
              </div>
            </div>

            {/* Tags + Genres — 2 columns */}
            <div className="grid grid-cols-2 gap-4">

              {/* Tags */}
              <div>
                <label className={labelCls}>Tags</label>
                <div className="relative">
                  {/* Selected chips */}
                  {selectedTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {selectedTags.map(tag => (
                        <span key={tag.id}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white"
                          style={{ backgroundColor: tag.color || '#6b7280' }}>
                          {tag.name}
                          <button type="button" onClick={() => setSelectedTags(ts => ts.filter(t => t.id !== tag.id))}
                            className="opacity-70 hover:opacity-100 leading-none">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={tagQuery}
                    onChange={e => { setTagQuery(e.target.value); setTagDropdownOpen(true) }}
                    onFocus={() => setTagDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setTagDropdownOpen(false), 150)}
                    placeholder="Search or create tags…"
                    className={inputCls}
                  />
                  {tagDropdownOpen && (tagQuery || filteredTags.length > 0) && (
                    <div className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-surface-raised shadow-lg max-h-48 overflow-y-auto">
                      {filteredTags.map(tag => (
                        <button key={tag.id} type="button"
                          onMouseDown={e => { e.preventDefault(); setSelectedTags(ts => [...ts, tag]); setTagQuery(''); tagInputRef.current?.focus() }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color || '#6b7280' }} />
                          <span className="text-content-strong">{tag.name}</span>
                        </button>
                      ))}
                      {tagQuery.trim() && !tagQueryMatchesExisting && (
                        <button type="button"
                          onMouseDown={e => { e.preventDefault(); createTag(tagQuery.trim()) }}
                          disabled={isCreatingTag}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-accent hover:bg-accent-surface transition-colors">
                          <span className="flex-shrink-0">+</span>
                          <span>Create "{tagQuery.trim()}"</span>
                          <div className="ml-auto">
                            <select value={newTagColor} onChange={e => { e.stopPropagation(); setNewTagColor(e.target.value) }}
                              onMouseDown={e => e.stopPropagation()}
                              onClick={e => e.stopPropagation()}
                              className="text-xs border border-line rounded px-1 py-0.5 bg-surface-raised text-content-tertiary">
                              {TAG_COLORS.filter(c => c.value).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                            </select>
                          </div>
                        </button>
                      )}
                      {filteredTags.length === 0 && !tagQuery.trim() && (
                        <p className="px-3 py-2 text-xs text-content-subtle">No more tags available</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Genres */}
              <div>
                <label className={labelCls}>Genres</label>
                <div className="relative">
                  {selectedGenres.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {selectedGenres.map(g => (
                        <span key={g.id}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
                          {g.name}
                          <button type="button" onClick={() => setSelectedGenres(gs => gs.filter(x => x.id !== g.id))}
                            className="opacity-70 hover:opacity-100 leading-none">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    ref={genreInputRef}
                    type="text"
                    value={genreQuery}
                    onChange={e => { setGenreQuery(e.target.value); setGenreDropdownOpen(true) }}
                    onFocus={() => setGenreDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setGenreDropdownOpen(false), 150)}
                    placeholder="Search genres…"
                    className={inputCls}
                  />
                  {genreDropdownOpen && filteredGenres.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-surface-raised shadow-lg max-h-48 overflow-y-auto">
                      {filteredGenres.map(g => (
                        <button key={g.id} type="button"
                          onMouseDown={e => { e.preventDefault(); setSelectedGenres(gs => [...gs, g]); setGenreQuery(''); genreInputRef.current?.focus() }}
                          className="w-full text-left px-3 py-2 text-sm text-content-strong hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                          {g.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {genreDropdownOpen && filteredGenres.length === 0 && genreQuery && (
                    <div className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-surface-raised shadow-lg px-3 py-2">
                      <p className="text-xs text-content-subtle">No matching genres</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <SeriesRowsField libraryId={targetLibrary} rows={seriesRows} onChange={setSeriesRows}
              inputCls={inputCls} labelCls={labelCls} />

            {/* Lists */}
            {allShelves.length > 0 && (
              <div>
                <label className={labelCls}>Lists</label>
                <div className="flex flex-wrap gap-2">
                  {allShelves.map(shelf => {
                    const checked = selectedShelfIds.has(shelf.id)
                    return (
                      <label key={shelf.id}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                          checked ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}>
                        <input type="checkbox" className="sr-only" checked={checked}
                          onChange={e => setSelectedShelfIds(ids => {
                            const next = new Set(ids)
                            if (e.target.checked) next.add(shelf.id)
                            else next.delete(shelf.id)
                            return next
                          })} />
                        {shelf.icon && <span>{shelf.icon}</span>}
                        {shelf.name}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Edition details */}
            <div className="rounded-xl border border-line overflow-hidden">
                <button type="button"
                  onClick={() => setShowEdition(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-content-secondary hover:bg-surface-muted transition-colors">
                  <span className="flex items-center gap-2">
                    <svg className={`w-3.5 h-3.5 transition-transform ${showEdition ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0L14 9.586l-5.293 5.293a1 1 0 01-1.414-1.414L11.586 9.586 6.293 4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                    <span>Edition details</span>
                    {!showEdition && <span className="text-xs font-normal text-content-subtle">— no edition will be created</span>}
                  </span>
                  {isbnEntered && !showEdition && (
                    <span className="text-xs text-accent">ISBN entered</span>
                  )}
                </button>
                {showEdition && (() => {
                  const isAudio = edition.format === 'audiobook'
                  const isEbook = edition.format === 'ebook' || edition.format === 'digital'
                  const isPhysical = !isAudio && !isEbook
                  return (
                  <div className="px-4 pb-4 pt-3 space-y-3 border-t border-line-subtle bg-gray-50/50 dark:bg-gray-800/30">
                    {/* Format buttons */}
                    <div className="grid grid-cols-4 gap-2">
                      {([
                        { value: 'paperback', label: 'Paperback', icon: (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                          </svg>
                        )},
                        { value: 'hardcover', label: 'Hardcover', icon: (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 4.5A2.25 2.25 0 018.25 2.25h10.5A1.5 1.5 0 0120.25 3.75v16.5a1.5 1.5 0 01-1.5 1.5H8.25A2.25 2.25 0 016 19.5v-15z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 4.5h1.5m-1.5 15h1.5" />
                            <line strokeLinecap="round" x1="7.5" y1="2.25" x2="7.5" y2="21.75" />
                          </svg>
                        )},
                        { value: 'ebook', label: 'E-Book', icon: (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5h3m-6.75 2.25h10.5a2.25 2.25 0 002.25-2.25v-15a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 4.5v15a2.25 2.25 0 002.25 2.25z" />
                          </svg>
                        )},
                        { value: 'audiobook', label: 'Audiobook', icon: (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a9 9 0 00-9 9v1.5A1.5 1.5 0 004.5 15H6a1.5 1.5 0 001.5-1.5v-3A1.5 1.5 0 006 9h-.35A7.5 7.5 0 0112 4.5a7.5 7.5 0 016.35 4.5H18a1.5 1.5 0 00-1.5 1.5v3A1.5 1.5 0 0018 15h1.5A1.5 1.5 0 0021 13.5V12a9 9 0 00-9-9z" />
                          </svg>
                        )},
                      ] as { value: string; label: string; icon: React.ReactNode }[]).map(fmt => (
                        <button key={fmt.value} type="button"
                          onClick={() => setEdition(d => ({ ...d, format: fmt.value }))}
                          className={`flex flex-col items-center gap-1.5 rounded-xl border-2 py-3 text-xs font-medium transition-colors ${
                            edition.format === fmt.value
                              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                              : 'border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700/40'
                          }`}>
                          {fmt.icon}
                          {fmt.label}
                        </button>
                      ))}
                    </div>

                    {/* Edition name */}
                    <div>
                      <label className={labelCls}>Edition name</label>
                      <input type="text" value={edition.edition_name} onChange={e => setEdition(d => ({ ...d, edition_name: e.target.value }))}
                        placeholder="e.g. 1st Edition" className={inputCls} />
                    </div>

                    {/* Row 2: publisher + publish date */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Publisher</label>
                        <input type="text" value={edition.publisher} onChange={e => setEdition(d => ({ ...d, publisher: e.target.value }))} className={inputCls} />
                      </div>
                      <div>
                        <label className={labelCls}>Publish date</label>
                        <input type="text" inputMode="numeric" placeholder="YYYY-MM-DD" pattern="\d{4}(-\d{2}(-\d{2})?)?" title="YYYY, YYYY-MM or YYYY-MM-DD" value={edition.publish_date} onChange={e => setEdition(d => ({ ...d, publish_date: e.target.value }))} className={inputCls} />
                      </div>
                    </div>

                    {/* Row 3: language (all formats) */}
                    <div>
                      <label className={labelCls}>Language</label>
                      <select value={edition.language} onChange={e => setEdition(d => ({ ...d, language: e.target.value }))} className={inputCls}>
                        <option value="">— select —</option>
                        {LANGUAGE_OPTIONS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                      </select>
                    </div>

                    {/* ISBNs: physical gets both, ebook gets ISBN-13 only, audiobook gets neither */}
                    {isPhysical && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>ISBN-13</label>
                          <input type="text" value={edition.isbn_13} onChange={e => setEdition(d => ({ ...d, isbn_13: e.target.value }))}
                            placeholder="978-…" className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>ISBN-10</label>
                          <input type="text" value={edition.isbn_10} onChange={e => setEdition(d => ({ ...d, isbn_10: e.target.value }))} className={inputCls} />
                        </div>
                      </div>
                    )}
                    {isEbook && (
                      <div>
                        <label className={labelCls}>ISBN-13</label>
                        <input type="text" value={edition.isbn_13} onChange={e => setEdition(d => ({ ...d, isbn_13: e.target.value }))}
                          placeholder="978-…" className={inputCls} />
                      </div>
                    )}

                    {/* Page count: physical + ebook */}
                    {!isAudio && (
                      <div>
                        <label className={labelCls}>Page count</label>
                        <input type="number" min="1" value={edition.page_count} onChange={e => setEdition(d => ({ ...d, page_count: e.target.value }))} className={inputCls} />
                      </div>
                    )}

                    {/* Duration + narrator: audiobook only */}
                    {isAudio && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className={labelCls}>Duration — hours</label>
                            <input type="number" min="0" value={edition.duration_hours}
                              onChange={e => setEdition(d => ({ ...d, duration_hours: e.target.value }))}
                              placeholder="0" className={inputCls} />
                          </div>
                          <div>
                            <label className={labelCls}>Duration — minutes</label>
                            <input type="number" min="0" max="59" value={edition.duration_minutes}
                              onChange={e => setEdition(d => ({ ...d, duration_minutes: e.target.value }))}
                              placeholder="0" className={inputCls} />
                          </div>
                        </div>
                        <div>
                          <label className={labelCls}>Narrator</label>
                          <input type="text" value={edition.narrator} onChange={e => setEdition(d => ({ ...d, narrator: e.target.value }))} className={inputCls} />
                        </div>
                      </div>
                    )}

                    {/* Date acquired moved to per-library tracking under M2M — follow-up. */}
                  </div>
                  )
                })()}
              </div>

            {error && <div className="rounded-xl bg-danger-surface border border-danger-line px-4 py-2.5 text-sm text-danger-strong">{error}</div>}
          </form>
          )}
        </div>
  )

  if (embed) {
    return (
      <>
        {body}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-t border-line px-6 py-4">
          <button type="button" onClick={embed.onLookUp} className="lb-btn ghost inline-flex items-center gap-1.5">
            <Icon name="barcode" className="h-4 w-4" />
            {t('add_books.look_it_up', { defaultValue: 'Look it up instead' })}
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="lb-btn ghost">
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button type="submit" form="book-form" className="lb-btn disabled:opacity-50" disabled={isLoading || !form.title || !form.media_type_id}>
            {isLoading ? t('add_books.adding', { defaultValue: 'Adding…' }) : embed.addLabel}
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
      <div className="w-full max-w-2xl rounded-2xl bg-surface shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-line flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-content">Add book</h2>
            {/* Only when the caller did not fix the library. Inside a library
                the answer is already known and asking would be noise. */}
            {!libraryId && (libraries?.length ?? 0) > 0 && (
              <label className="ml-auto mr-3 flex items-center gap-2 text-xs text-content-tertiary">
                Library
                {/* Locked while a sweep holds rows. The detection callback
                    closes over the library it started with, so switching
                    mid-sweep would check duplicates against one library and
                    post the queued books to another. Freezing the choice is
                    kinder than silently discarding what has been scanned. */}
                <select
                  className="lb-field w-auto disabled:opacity-50"
                  value={chosenLibrary}
                  disabled={scanned.length > 0}
                  title={scanned.length > 0
                    ? t('scan.library_locked', {
                        defaultValue: 'Finish or clear the scan session to change library.',
                      })
                    : undefined}
                  onChange={e => setChosenLibrary(e.target.value)}
                >
                  {libraries!.map(l => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" onClick={closeModal}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-surface-inset transition-colors"
              aria-label="Close">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="mt-3 flex gap-1 rounded-lg bg-surface-inset p-1">
            <button type="button" onClick={() => setMode('isbn')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'isbn' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              By ISBN
            </button>
            <button type="button" onClick={() => setMode('search')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'search' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              By Title
            </button>
            <button type="button" onClick={() => setMode('manual')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'manual' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              Manual
            </button>
          </div>
        </div>

        {body}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex justify-end gap-3 flex-shrink-0">
          <button type="button" onClick={closeModal}
            className="rounded-lg border border-line-strong px-5 py-2 text-sm font-medium text-content-secondary hover:bg-surface-muted transition-colors">
            Cancel
          </button>
          {mode === 'manual' && (
            <button type="submit" form="book-form" disabled={isLoading || !form.title || !form.media_type_id}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {isLoading ? 'Saving…' : 'Add book'}
            </button>
          )}
        </div>

      </div>
    </div>
  )
}

// ─── Add/Edit Edition modal ───────────────────────────────────────────────────
