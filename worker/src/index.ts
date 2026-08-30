import schedule from "./data/schedule.json"

interface Env { PRT_API_BASE_URL?: string; PRT_API_KEY?: string; PRT_RTPI_DATA_FEED?: string }
type AnyRecord = Record<string, any>
type ScheduleTrip = { tripId: string; routeId: string; serviceId: string; time: string }
type ScheduleData = { tripsByStop: Record<string, ScheduleTrip[]>; calendar: AnyRecord[]; calendarDates: AnyRecord[] }
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
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
function epochSecondsValue(value: unknown) {
  const numeric = numberValue(value)
  if (numeric === undefined) return undefined
  return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric
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
  return (scheduleData.tripsByStop[stopId] ?? []).flatMap((trip) => {
    if (!active.has(trip.serviceId)) return []
    const seconds = serviceDateEpoch(now, trip.time)
    if (seconds < nowSeconds || seconds > nowSeconds + WINDOW_SECONDS) return []
    return [{ routeId: trip.routeId, tripId: trip.tripId, scheduledTime: timeLabel(seconds), scheduledTimestamp: new Date(seconds * 1000).toISOString(), scheduledEpoch: seconds, realtime: false }]
  })
}

function arrayField(value: unknown, ...names: string[]) {
  const result = field(value as AnyRecord | undefined, ...names)
  if (Array.isArray(result)) return result
  return result ? [result] : []
}

async function parseApiResponse(response: Response) {
  const body = (await response.text()).replace(/^\uFEFF/, "")
  try {
    return JSON.parse(body) as AnyRecord
  } catch (error) {
    // Some BusTime deployments emit non-standard escapes such as \\' in
    // otherwise valid JSON. Preserve valid escapes and quote only invalid ones.
    const repaired = body.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
    try {
      return JSON.parse(repaired) as AnyRecord
    } catch {
      throw new Error(`Invalid BusTime API response (${response.headers.get("content-type") ?? "unknown content type"}): ${error instanceof Error ? error.message : "unknown parse error"}; body=${body.slice(0, 160)}`)
    }
  }
}

function normalize(apiResponse: AnyRecord, vehicleResponse?: AnyRecord, nowSeconds = Math.floor(Date.now() / 1000), stopId = DEFAULT_STOP_ID) {
  const arrivals: AnyRecord[] = scheduledArrivals(nowSeconds, stopId)
  const statuses = new Map<string, "moving" | "stopped" | "unknown">()
  for (const vehicle of arrayField(vehicleResponse?.["bustime-response"], "vehicle", "vehicles")) {
    const id = field(vehicle, "vid")
    const speed = numberValue(field(vehicle, "spd"))
    if (id) statuses.set(String(id), speed === undefined ? "unknown" : speed > 0 ? "moving" : "stopped")
  }
  const realtimeByTrip = new Map<string, AnyRecord>()
  const root = apiResponse?.["bustime-response"] ?? {}
  for (const prediction of arrayField(root, "prd", "predictions")) {
    const routeId = String(field(prediction, "rt", "rtdd") ?? "")
    if (!ROUTES.has(routeId) || String(field(prediction, "stpid") ?? "") !== stopId) continue
    if (String(field(prediction, "typ") ?? "A").toUpperCase() === "D") continue
    const predictedTimestamp = epochSecondsValue(field(prediction, "prdtm"))
    const countdownMinutes = numberValue(field(prediction, "prdctdn"))
    const predictedEpoch = predictedTimestamp ?? (countdownMinutes === undefined ? undefined : nowSeconds + countdownMinutes * 60)
    if (predictedEpoch === undefined || predictedEpoch < nowSeconds || predictedEpoch > nowSeconds + WINDOW_SECONDS) continue
    const vehicleId = field(prediction, "vid")
    const tripId = field(prediction, "origtatripno", "tatripid")
    const item = { routeId, tripId: tripId ? String(tripId) : undefined, predictedTime: new Date(predictedEpoch * 1000).toISOString(), scheduledTime: timeLabel(predictedEpoch), realtime: true, vehicleStatus: vehicleId ? (statuses.get(String(vehicleId)) ?? "unknown") : "unknown", predictedEpoch }
    if (tripId) realtimeByTrip.set(String(tripId), item)
    else arrivals.push(item)
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
  return { arrivals, source: "PRT BusTime API", fetchedAt: new Date().toISOString() }
}

function staticFallback(stopId: string, warning: string) {
  return { ...normalize({}, undefined, Math.floor(Date.now() / 1000), stopId), source: "PRT BusTime API unavailable; static schedule", warning }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders })
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders })
    try {
      const requestedStop = new URL(request.url).searchParams.get("stop") ?? DEFAULT_STOP_ID
      if (!/^[A-Za-z0-9_-]+$/.test(requestedStop)) return new Response("Invalid stop", { status: 400, headers: corsHeaders })
      if (!env.PRT_API_KEY) return new Response("PRT API key is not configured", { status: 503, headers: corsHeaders })
      const baseUrl = env.PRT_API_BASE_URL ?? "http://realtime.portauthority.org/bustime/api/v3"
      const rtpiDataFeed = env.PRT_RTPI_DATA_FEED ?? "bustime"
      const predictionUrl = new URL(`${baseUrl.replace(/\/$/, "")}/getpredictions`)
      predictionUrl.searchParams.set("key", env.PRT_API_KEY)
      predictionUrl.searchParams.set("stpid", requestedStop)
      predictionUrl.searchParams.set("rt", [...ROUTES].join(","))
      predictionUrl.searchParams.set("format", "json")
      predictionUrl.searchParams.set("unixTime", "true")
      predictionUrl.searchParams.set("tmres", "s")
      predictionUrl.searchParams.set("rtpidatafeed", rtpiDataFeed)
      const vehicleUrl = new URL(`${baseUrl.replace(/\/$/, "")}/getvehicles`)
      vehicleUrl.searchParams.set("key", env.PRT_API_KEY)
      vehicleUrl.searchParams.set("rt", [...ROUTES].join(","))
      vehicleUrl.searchParams.set("format", "json")
      vehicleUrl.searchParams.set("tmres", "s")
      vehicleUrl.searchParams.set("rtpidatafeed", rtpiDataFeed)
      const [upstream, vehicles] = await Promise.all([
        fetch(predictionUrl, { cache: "no-store" }),
        fetch(vehicleUrl, { cache: "no-store" }),
      ])
      if (!upstream.ok) {
        const body = (await upstream.text()).replace(/key=[^&\s]+/gi, "key=[redacted]").slice(0, 240)
        console.error("PRT prediction request failed", upstream.status, upstream.headers.get("content-type"), body)
        return new Response(JSON.stringify(staticFallback(requestedStop, `Upstream status ${upstream.status}`)), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } })
      }
      const apiResponse = await parseApiResponse(upstream)
      const apiErrors = arrayField(apiResponse?.["bustime-response"], "error")
      const apiErrorMessage = apiErrors.map((entry) => String(field(entry, "msg") ?? "")).join("; ")
      const noPredictions = /no (predictions?|data|arrivals?)/i.test(apiErrorMessage)
      const apiError = apiErrors.length > 0 && !noPredictions
      if (apiError) {
        console.error("PRT API error", apiErrorMessage)
        return new Response(JSON.stringify(staticFallback(requestedStop, apiErrorMessage || "Unknown API error")), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } })
      }
      const nowSeconds = Math.floor(Date.now() / 1000)
      let vehicleResponse: AnyRecord | undefined
      if (vehicles.ok) {
        try {
          vehicleResponse = await parseApiResponse(vehicles)
        } catch (error) {
          // Vehicle data is supplementary; a malformed/unavailable vehicle
          // response must not hide valid arrival predictions.
          console.error("Unable to parse PRT vehicle response", error)
        }
      }
      const result = normalize(apiResponse, vehicleResponse, nowSeconds, requestedStop)
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } })
    } catch (error) {
      console.error(error)
      const requestedStop = new URL(request.url).searchParams.get("stop") ?? DEFAULT_STOP_ID
      return new Response(JSON.stringify(staticFallback(requestedStop, error instanceof Error ? error.message : "unknown error")), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } })
    }
  },
}

export { normalize }
