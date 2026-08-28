import GtfsRealtimeBindings from "gtfs-realtime-bindings"
import schedule from "./data/schedule.json"

interface Env { PRT_TRIP_UPDATES_URL: string }
type AnyRecord = Record<string, any>
type ScheduleData = { trips: AnyRecord[]; calendar: AnyRecord[]; calendarDates: AnyRecord[] }
const scheduleData = schedule as unknown as ScheduleData
const ROUTES = new Set(["61A", "61B", "61C", "61D"])
const DEFAULT_STOP_ID = "7097"
const WINDOW_SECONDS = 30 * 60
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store" }

function field(object: AnyRecord | undefined, ...names: string[]) {
  for (const name of names) if (object?.[name] !== undefined) return object[name]
  return undefined
}
function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && value.trim()) return Number(value)
  if (value && typeof value === "object") {
    const candidate = value as AnyRecord
    if (typeof candidate.toNumber === "function") return candidate.toNumber()
    if (typeof candidate.low === "number") return candidate.low + (candidate.high ?? 0) * 2 ** 32
  }
  return undefined
}
function timeLabel(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })
}

function localDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("-", "")
}

function activeServices(date: Date) {
  const key = localDateKey(date)
  const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(date).toLowerCase()
  const active = new Set(scheduleData.calendar.filter((row) => row.start_date <= key && key <= row.end_date && row[weekdayName] === "1").map((row) => row.service_id))
  for (const exception of scheduleData.calendarDates) {
    if (exception.date !== key) continue
    if (exception.exception_type === "1") active.add(exception.service_id)
    if (exception.exception_type === "2") active.delete(exception.service_id)
  }
  return active
}

function serviceDateEpoch(date: Date, time: string) {
  const [hours, minutes, seconds] = time.split(":").map(Number)
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date)
  const y = Number(parts.find((part) => part.type === "year")?.value)
  const m = Number(parts.find((part) => part.type === "month")?.value) - 1
  const d = Number(parts.find((part) => part.type === "day")?.value)
  const utcGuess = Date.UTC(y, m, d, hours % 24, minutes, seconds)
  const displayed = new Date(utcGuess).toLocaleString("en-US", { timeZone: "America/New_York" })
  const offset = Date.parse(displayed) - utcGuess
  return Math.floor((utcGuess - offset) / 1000) + Math.floor(hours / 24) * 86400
}

function scheduledArrivals(nowSeconds: number, stopId: string) {
  const now = new Date(nowSeconds * 1000)
  const active = activeServices(now)
  return scheduleData.trips.flatMap((trip) => {
    if (!active.has(trip.serviceId) || trip.stopId !== stopId) return []
    const seconds = serviceDateEpoch(now, trip.arrivalTime ?? trip.departureTime)
    if (seconds < nowSeconds || seconds > nowSeconds + WINDOW_SECONDS) return []
    return [{ routeId: trip.routeId, tripId: trip.tripId, headsign: trip.headsign || undefined, scheduledTime: timeLabel(seconds), scheduledTimestamp: new Date(seconds * 1000).toISOString(), scheduledEpoch: seconds, realtime: false }]
  })
}

function normalize(buffer: ArrayBuffer, nowSeconds = Math.floor(Date.now() / 1000), stopId = DEFAULT_STOP_ID) {
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer)) as AnyRecord
  const arrivals: AnyRecord[] = scheduledArrivals(nowSeconds, stopId)
  const realtimeByTrip = new Map<string, AnyRecord>()
  for (const entity of feed.entity ?? []) {
    const update = field(entity, "tripUpdate", "trip_update") as AnyRecord | undefined
    if (!update) continue
    const trip = field(update, "trip") as AnyRecord | undefined
    const routeId = field(trip, "routeId", "route_id")
    const tripId = field(trip, "tripId", "trip_id")
    const relationship = String(field(trip, "scheduleRelationship", "schedule_relationship") ?? "").toUpperCase()
    if (!trip || !ROUTES.has(String(routeId)) || relationship === "CANCELED") continue
    const updates = field(update, "stopTimeUpdate", "stop_time_update") ?? []
    for (const stopUpdate of updates) {
      if (String(field(stopUpdate, "stopId", "stop_id") ?? "") !== stopId) continue
      const stopRelationship = String(field(stopUpdate, "scheduleRelationship", "schedule_relationship") ?? "").toUpperCase()
      if (stopRelationship === "SKIPPED") continue
      const event = field(stopUpdate, "arrival") ?? field(stopUpdate, "departure")
      const epochSeconds = numberValue(field(event, "time"))
      if (epochSeconds === undefined || epochSeconds < nowSeconds || epochSeconds > nowSeconds + WINDOW_SECONDS) continue
      const item = { routeId: String(routeId), tripId: tripId ? String(tripId) : undefined, predictedTime: new Date(epochSeconds * 1000).toISOString(), scheduledTime: timeLabel(epochSeconds), realtime: true, predictedEpoch: epochSeconds }
      if (tripId) realtimeByTrip.set(String(tripId), item)
      else arrivals.push(item)
      break
    }
  }
  for (let index = arrivals.length - 1; index >= 0; index--) {
    const scheduled = arrivals[index]
    const realtime = scheduled.tripId ? realtimeByTrip.get(scheduled.tripId) : undefined
    if (!realtime) continue
    arrivals[index] = { ...scheduled, ...realtime, scheduledTime: scheduled.scheduledTime, predictedTime: realtime.predictedTime, realtime: true }
    realtimeByTrip.delete(scheduled.tripId)
  }
  arrivals.push(...realtimeByTrip.values())
  arrivals.sort((a, b) => (a.predictedEpoch ?? a.scheduledEpoch) - (b.predictedEpoch ?? b.scheduledEpoch))
  arrivals.forEach((arrival) => { delete arrival.predictedEpoch; delete arrival.scheduledEpoch })
  return { arrivals, source: "PRT GTFS-Realtime", fetchedAt: new Date().toISOString() }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders })
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders })
    try {
      const upstream = await fetch(env.PRT_TRIP_UPDATES_URL, { headers: { Accept: "application/octet-stream" } })
      if (!upstream.ok) return new Response(`PRT feed returned ${upstream.status}`, { status: 502, headers: corsHeaders })
      const requestedStop = new URL(request.url).searchParams.get("stop") ?? DEFAULT_STOP_ID
      if (!/^[A-Za-z0-9_-]+$/.test(requestedStop)) return new Response("Invalid stop", { status: 400, headers: corsHeaders })
      const result = normalize(await upstream.arrayBuffer(), Math.floor(Date.now() / 1000), requestedStop)
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } })
    } catch (error) {
      console.error(error)
      return new Response("Unable to decode PRT feed", { status: 502, headers: corsHeaders })
    }
  },
}

export { normalize }
