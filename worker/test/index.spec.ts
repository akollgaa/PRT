import { describe, it, expect } from "vitest";
import { normalize } from "../src/index";

const sundayMorning = Date.parse("2026-08-30T13:30:00Z") / 1000;

describe("arrival Worker", () => {
	it("keeps a scheduled trip when its stop has no realtime prediction", () => {
		const result = normalize({ "bustime-response": { prd: [] } }, undefined, sundayMorning, "7097");
		expect(result.arrivals.some((arrival) => arrival.realtime === false)).toBe(true);
	});

	it("does not return trips from another stop", () => {
		const result = normalize({ "bustime-response": { prd: [] } }, undefined, sundayMorning, "not-a-prt-stop");
		expect(result.arrivals).toEqual([]);
	});
});
