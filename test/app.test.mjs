// Tests for the app's pure helpers and API client. The app has no modules:
// Spicetify concatenates the three files into one script, so this does the
// same in a VM context with a minimal Spicetify stub, and reads the helpers
// back out. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const files = ["index.js", "components.js", "pages.js"].map((name) => readFileSync(new URL(`../warehouse/${name}`, import.meta.url), "utf8"));
const exported = [
	"ApiError",
	"api",
	"warehouseUrlError",
	"retryAfterSeconds",
	"safeDecode",
	"safeExternalUrl",
	"needsLookup",
	"cachedArtist",
	"mapLimit",
	"graphqlData",
	"MISS_TTL_MS",
	"playKey",
	"appendPlays",
	"nextPlaysCursor",
	"sortConcerts",
	"clockStats",
	"onRepeatCaption",
	"RANGES",
];

/** The app's helpers, with `fetch` answered by `fetchStub`. */
function load(fetchStub = () => Promise.reject(new Error("no fetch"))) {
	const storage = new Map();
	const context = vm.createContext({
		Spicetify: {
			React: { createElement: () => null, Component: class {}, Fragment: "fragment" },
			LocalStorage: { get: (key) => storage.get(key) ?? null, set: (key, value) => storage.set(key, value) },
		},
		fetch: (...args) => fetchStub(...args),
		Intl,
		URL,
		AbortController,
		AbortSignal,
		DOMException,
		setTimeout,
		clearTimeout,
		console,
	});
	return vm.runInContext(`${files.join("\n")}\n;({ ${exported.join(", ")} })`, context);
}

function response(status, body, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers });
}

const settings = { url: "https://warehouse.example.com", token: "t" };

test("warehouse URL must be https, or http to this machine", () => {
	const { warehouseUrlError } = load();
	for (const url of ["https://warehouse.example.com", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
		assert.equal(warehouseUrlError(url), null, url);
	}
	for (const url of ["http://warehouse.example.com", "javascript:alert(1)", "ftp://localhost", "warehouse.example.com", ""]) {
		assert.match(warehouseUrlError(url), /https/, url);
	}
});

test("Retry-After is read as capped seconds, or null", () => {
	const { retryAfterSeconds } = load();
	assert.equal(retryAfterSeconds("5"), 5);
	assert.equal(retryAfterSeconds("0"), 0);
	assert.equal(retryAfterSeconds("120"), 30);
	assert.equal(retryAfterSeconds(null), null);
	assert.equal(retryAfterSeconds(""), null);
	assert.equal(retryAfterSeconds("soon"), null);
});

test("api retries a still-computing 503 once, after Retry-After", async () => {
	const calls = [];
	const answers = [response(503, { error: "computing" }, { "Retry-After": "0" }), response(200, { ok: true })];
	const { api } = load((url) => {
		calls.push(url);
		return Promise.resolve(answers.shift());
	});
	assert.deepEqual({ ...(await api("/api/stats/rhythm", settings)) }, { ok: true });
	assert.equal(calls.length, 2);
});

test("api doesn't retry a 503 that needs re-authorization", async () => {
	let calls = 0;
	const { api } = load(() => {
		calls++;
		return Promise.resolve(response(503, { error: "Spotify connection needs re-authorization.", needs_reauth: true }, { "Retry-After": "0" }));
	});
	await assert.rejects(api("/api/now-playing", settings), (error) => error.status === 503 && /re-authoriz/.test(error.message));
	assert.equal(calls, 1);
});

test("api doesn't retry a 503 without Retry-After", async () => {
	let calls = 0;
	const { api } = load(() => {
		calls++;
		return Promise.resolve(response(503, { error: "down" }));
	});
	await assert.rejects(api("/api/plays", settings), /down/);
	assert.equal(calls, 1);
});

test("api refuses a plain-http URL before fetching", async () => {
	let calls = 0;
	const { api } = load(() => {
		calls++;
		return Promise.resolve(response(200, {}));
	});
	await assert.rejects(api("/api/plays", { url: "http://warehouse.example.com", token: "t" }), /https/);
	assert.equal(calls, 0);
});

test("api names a timeout, and passes a caller's abort through", async () => {
	const timedOut = load(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
	await assert.rejects(timedOut.api("/api/plays", settings), /didn't answer within 20 seconds/);

	const controller = new AbortController();
	const aborted = load((url, { signal }) => {
		controller.abort();
		return Promise.reject(signal.reason);
	});
	await assert.rejects(aborted.api("/api/plays", settings, { signal: controller.signal }), (error) => error.name === "AbortError");
});

test("api sends a signal that combines the caller's and a timeout", async () => {
	let sent;
	const { api } = load((url, init) => {
		sent = init.signal;
		return Promise.resolve(response(200, {}));
	});
	const controller = new AbortController();
	await api("/api/plays", settings, { signal: controller.signal });
	assert.ok(sent && sent !== controller.signal);
	controller.abort();
	assert.equal(sent.aborted, true);
});

test("safeDecode returns null for a malformed escape", () => {
	const { safeDecode } = load();
	assert.equal(safeDecode("name%3AB%C3%B8rns"), "name:Børns");
	assert.equal(safeDecode("%E0%A4%A"), null);
});

test("safeExternalUrl allows only https", () => {
	const { safeExternalUrl } = load();
	assert.equal(safeExternalUrl("https://www.ticketmaster.co.uk/event/1"), "https://www.ticketmaster.co.uk/event/1");
	for (const url of [null, undefined, "", "javascript:alert(1)", "http://example.com", "data:text/html,hi", "/relative"]) {
		assert.equal(safeExternalUrl(url), null, String(url));
	}
});

test("artist cache: hits persist, misses expire after a day, legacy misses retry", () => {
	const { needsLookup, cachedArtist, MISS_TTL_MS } = load();
	const now = 10 * MISS_TTL_MS;
	const hit = { uri: "spotify:artist:x", image: "a", large: "b" };
	assert.equal(needsLookup(undefined, now), true);
	assert.equal(needsLookup(null, now), true);
	assert.equal(needsLookup(hit, now), false);
	assert.equal(needsLookup({ uri: "spotify:artist:x", image: "a" }, now), true);
	assert.equal(needsLookup({ missedAt: now - 1000 }, now), false);
	assert.equal(needsLookup({ missedAt: now - MISS_TTL_MS - 1 }, now), true);
	assert.equal(cachedArtist(hit), hit);
	assert.equal(cachedArtist({ missedAt: now }), null);
	assert.equal(cachedArtist(undefined), null);
});

test("graphqlData throws on errors rather than reading them as a miss", () => {
	const { graphqlData } = load();
	assert.throws(() => graphqlData({ errors: [{ message: "nope" }], data: null }), /nope/);
	assert.deepEqual({ ...graphqlData({ data: { a: 1 } }) }, { a: 1 });
});

test("mapLimit keeps order and never runs more than the limit at once", async () => {
	const { mapLimit } = load();
	let running = 0;
	let peak = 0;
	const results = await mapLimit([...Array(20).keys()], 4, async (n) => {
		running++;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 1));
		running--;
		return n * 2;
	});
	assert.equal(peak, 4);
	assert.deepEqual([...results], [...Array(20).keys()].map((n) => n * 2));
	assert.deepEqual([...(await mapLimit([], 4, async () => 1))], []);
});

test("plays page by next_before when the warehouse sends it", () => {
	const { nextPlaysCursor } = load();
	const plays = [{ played_at_ms: 5, track_id: "a" }];
	assert.equal(nextPlaysCursor({ plays, next_before: "opaque" }, 50), "opaque");
	assert.equal(nextPlaysCursor({ plays, next_before: null }, 1), null);
});

test("without next_before, plays page from just after the last ms, and dedupe", () => {
	const { nextPlaysCursor, appendPlays, playKey } = load();
	const page = [
		{ played_at_ms: 9, track_id: "a" },
		{ played_at_ms: 7, track_id: "b" },
	];
	assert.equal(nextPlaysCursor({ plays: page }, 2), "8");
	assert.equal(nextPlaysCursor({ plays: page }, 50), null);
	assert.equal(nextPlaysCursor({ plays: [] }, 50), null);
	// The next page repeats the play at ms 7 and has another at the same ms.
	const next = [
		{ played_at_ms: 7, track_id: "b" },
		{ played_at_ms: 7, track_id: "c" },
		{ played_at_ms: 3, track_id: "d" },
	];
	assert.deepEqual([...appendPlays(page, next).map(playKey)], ["9-a", "7-b", "7-c", "3-d"]);
});

test("concerts sort by date and time, undated last", () => {
	const { sortConcerts } = load();
	const sorted = sortConcerts([
		{ name: "tba", date: null, time: null },
		{ name: "late", date: "2026-11-02", time: "20:00" },
		{ name: "early", date: "2026-11-02", time: "19:00" },
		{ name: "first", date: "2026-10-20", time: null },
	]);
	assert.deepEqual(
		[...sorted.map((concert) => concert.name)],
		["first", "early", "late", "tba"],
	);
});

test("All time stays under the Worker's 3,660-day cap across a DST change", () => {
	const { RANGES } = load();
	assert.equal(RANGES.find((range) => range.key === "all").days, 3659);
});

// Bodies shaped exactly as the Worker's src/stats/rhythm.ts and repeat.ts
// send them, so a renamed or re-meant field shows up here.
const rhythmBody = {
	as_of: "2026-10-19T00:00:00.000Z",
	range: { from: "2019-01", to: "2026-10" },
	streaks: [
		{ threshold: 1, current_weeks: 12, longest: { days: 210, weeks: 30, from: "2024-01", to: "2024-07", running: false }, top: [], active_share: 0.874 },
		{ threshold: 10, current_weeks: 0, longest: null, top: [], active_share: 0.3 },
		{ threshold: 25, current_weeks: 0, longest: null, top: [], active_share: 0.05 },
	],
	eras: [{ key: "home", label: "Home", from: "2019-01", to: null, hour_share: null, grid: null, hours_available_from: null, grid_available_from: null }],
	years: [],
};

test("listening clock reads the daily streak set: whole weeks, and active_share as a share of days", () => {
	const { clockStats } = load();
	// Through JSON: the helpers' arrays come from the VM's own realm.
	assert.deepEqual(JSON.parse(JSON.stringify(clockStats(rhythmBody).filter(Boolean))), [
		["Weeks in a row with a play", "12"],
		["Longest run, in weeks", "30"],
		["Days with any listening", "87%"],
	]);
	// A running longest streak has no exact day count, only weeks.
	const running = { ...rhythmBody, streaks: [{ threshold: 1, current_weeks: 2, longest: { days: null, weeks: 2, from: "2026-10", to: "2026-10", running: true }, top: [], active_share: 1 }] };
	assert.deepEqual(JSON.parse(JSON.stringify(clockStats(running).filter(Boolean))), [
		["Weeks in a row with a play", "2"],
		["Longest run, in weeks", "2"],
		["Days with any listening", "100%"],
	]);
	assert.equal(clockStats(null), null);
	assert.equal(clockStats({ streaks: [] }), null);
});

test("on repeat says how long the warehouse's window is", () => {
	const { onRepeatCaption } = load();
	assert.equal(onRepeatCaption({ as_of: "2026-10-21T00:00:00.000Z", window_days: 14, tracks: [], albums: [] }), "Last 14 days");
	assert.equal(onRepeatCaption({ window_days: 28, tracks: [], albums: [] }), "Last 28 days");
	assert.equal(onRepeatCaption(null), "Last 14 days");
});
