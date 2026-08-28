import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Arrival = { routeId: string; headsign?: string; predictedTime?: string; scheduledTime: string; scheduledTimestamp?: string; realtime?: boolean; tripId?: string }
type FeedResponse = { arrivals: Arrival[]; source?: string }

const ROUTES = ['61A', '61B', '61C', '61D']
const DEFAULT_STOP_ID = '7097'
const REFRESH_MS = 30_000
const FACT_ROTATION_MS = 12 * 60 * 60 * 1000
const FEED_URL = import.meta.env.VITE_ARRIVALS_URL as string | undefined

const demoArrivals: Arrival[] = [
  { routeId: '61A', headsign: 'Braddock-Swissvale', scheduledTime: '10:08 AM', predictedTime: '10:10 AM', realtime: true },
  { routeId: '61C', headsign: 'Braddock-Swissvale', scheduledTime: '10:17 AM', predictedTime: '10:18 AM', realtime: true },
  { routeId: '61B', headsign: 'East Pittsburgh', scheduledTime: '10:26 AM' },
]

function arrivalTime(time: string) {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function countdown(time: string) {
  const totalSeconds = Math.floor((new Date(time).getTime() - Date.now()) / 1000)
  if (totalSeconds < 0) return 'DUE'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function App() {
  const [feed, setFeed] = useState<FeedResponse | null>(FEED_URL ? null : { arrivals: demoArrivals, source: 'Demo data' })
  const [stopInput, setStopInput] = useState(() => localStorage.getItem('prt-stop-id') ?? DEFAULT_STOP_ID)
  const [stopId, setStopId] = useState(() => localStorage.getItem('prt-stop-id') ?? DEFAULT_STOP_ID)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(new Date())
  const [clock, setClock] = useState(new Date())
  const [facts, setFacts] = useState<string[]>([])
  const [fact, setFact] = useState('')

  const refresh = useCallback(async () => {
    if (!FEED_URL) return
    try {
      const url = new URL(FEED_URL)
      url.searchParams.set('stop', stopId)
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Feed returned ${response.status}`)
      setFeed(await response.json() as FeedResponse)
      setUpdatedAt(new Date())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load arrival data')
    }
  }, [stopId])

  function submitStop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextStop = stopInput.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(nextStop)) return
    localStorage.setItem('prt-stop-id', nextStop)
    setStopId(nextStop)
  }

  useEffect(() => {
    refresh()
    const refreshTimer = window.setInterval(refresh, REFRESH_MS)
    const clockTimer = window.setInterval(() => setClock(new Date()), 1000)
    return () => { window.clearInterval(refreshTimer); window.clearInterval(clockTimer) }
  }, [refresh])

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}facts.txt`)
      .then((response) => response.text())
      .then((text) => setFacts(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))
      .catch(() => setFacts([]))
  }, [])

  useEffect(() => {
    const chooseFact = () => {
      if (!facts.length) return
      const windowNumber = Math.floor(Date.now() / FACT_ROTATION_MS)
      const pseudoRandom = Math.abs(Math.sin(windowNumber * 12.9898) * 43758.5453)
      setFact(facts[Math.floor((pseudoRandom % 1) * facts.length)])
    }
    chooseFact()
    const timer = window.setInterval(chooseFact, 60_000)
    return () => window.clearInterval(timer)
  }, [facts])

  const arrivals = useMemo(() => (feed?.arrivals ?? []).filter((arrival) => ROUTES.includes(arrival.routeId)).slice(0, 20), [feed])

  return <main className="board">
    <header className="board-header">
          <div><p className="eyebrow">Made by Adam Kollgaard</p><h1>Bus Arrival Board</h1><form className="stop" onSubmit={submitStop}><label htmlFor="stop-id">Stop</label><input id="stop-id" value={stopInput} onChange={(event) => setStopInput(event.target.value)} inputMode="numeric" aria-label="Stop ID" /><button type="submit">Update</button><span>•</span> 61A · 61B · 61C · 61D</form></div>
      <div className="header-side">{fact && <aside className="fact"><span>Fun fact</span><p>{fact}</p></aside>}<div className="clock"><strong>{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong><span>{clock.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</span></div></div>
    </header>
    {error && <div className="status status-error">Live feed unavailable — showing the last successful update.</div>}
    {!FEED_URL && <div className="status status-demo">Demo mode — set <code>VITE_ARRIVALS_URL</code> to connect the Cloudflare Worker.</div>}
    <section className="arrivals" aria-live="polite">
      <div className="table-heading"><span>Route & destination</span><span>Arrival</span></div>
      {arrivals.length === 0 && <div className="empty">No buses are predicted right now.</div>}
      {arrivals.map((arrival, index) => <article className="arrival" key={`${arrival.tripId ?? arrival.routeId}-${arrival.predictedTime ?? arrival.scheduledTime}-${index}`}>
        <div className={`route route-${arrival.routeId}`}>{arrival.routeId}</div>
        <div className="destination"><span className={arrival.realtime ? 'prediction-status realtime' : 'prediction-status scheduled'}>{arrival.realtime ? 'Realtime prediction' : 'Scheduled'}</span></div>
        <div className="times"><strong>{arrival.predictedTime ? arrivalTime(arrival.predictedTime) : arrival.scheduledTime}</strong>{arrival.predictedTime && <span>Scheduled {arrival.scheduledTime}</span>}</div>
        <div className="countdown">{arrival.predictedTime || arrival.scheduledTimestamp ? countdown(arrival.predictedTime ?? arrival.scheduledTimestamp!) : '—'}</div>
      </article>)}
    </section>
    <footer className="board-footer"><span>Updated {updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span><span>Predictions refresh every 30 seconds</span><span>{feed?.source ?? 'Live GTFS-Realtime'}</span></footer>
  </main>
}

export default App
