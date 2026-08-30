import { mkdir, writeFile } from "node:fs/promises"
import { unzipSync } from "fflate"
import { parse } from "csv-parse/sync"

const URL = "https://www.rideprt.org/developerresources/GTFS.zip"
const routes = new Set(["61A", "61B", "61C", "61D"])

const response = await fetch(URL)
if (!response.ok) throw new Error(`GTFS download failed: ${response.status}`)
const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
const read = (name) => files[name] ? new TextDecoder().decode(files[name]) : ""
const rows = (name) => parse(read(name), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true })

const trips = rows("trips.txt")
const matchingTrips = new Map(trips.filter((trip) => routes.has(trip.route_id)).map((trip) => [trip.trip_id, trip]))
const stopTimes = rows("stop_times.txt").filter((row) => matchingTrips.has(row.trip_id))
const selectedTripIds = new Set(stopTimes.map((row) => row.trip_id))
const tripsByStop = {}

for (const stop of stopTimes) {
  const trip = matchingTrips.get(stop.trip_id)
  const stopTrips = tripsByStop[stop.stop_id] ??= []
  stopTrips.push({
    tripId: stop.trip_id,
    routeId: trip.route_id,
    serviceId: trip.service_id,
    time: stop.arrival_time || stop.departure_time,
  })
}

const schedule = {
  generatedAt: new Date().toISOString(),
  tripsByStop,
  calendar: rows("calendar.txt"),
  calendarDates: rows("calendar_dates.txt").filter((row) => matchingTripsHasService(matchingTrips, selectedTripIds, row.service_id)),
}

function matchingTripsHasService(tripMap, tripIds, serviceId) {
  for (const tripId of tripIds) if (tripMap.get(tripId)?.service_id === serviceId) return true
  return false
}

await mkdir("src/data", { recursive: true })
await writeFile("src/data/schedule.json", JSON.stringify(schedule))
console.log(`Wrote ${stopTimes.length} stop trips across ${Object.keys(tripsByStop).length} stops to src/data/schedule.json`)
