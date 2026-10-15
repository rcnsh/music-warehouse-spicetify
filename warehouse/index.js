// A Spicetify custom app over a music-warehouse Worker. It reads only the
// warehouse's /api/* routes, never Spotify's Web API, so Spotify's rate limits
// don't touch it. No build step: plain JS against Spicetify.React.

/** @type {typeof import("react")} */
const react = Spicetify.React;
const { useState, useEffect, useCallback } = react;
const h = react.createElement;

const STORAGE = { url: "warehouse:url", token: "warehouse:token", range: "warehouse:range" };

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const RANGES = [
	{ key: "4w", label: "4 weeks", days: 28 },
	{ key: "6m", label: "6 months", days: 182 },
	{ key: "1y", label: "Year", days: 365 },
	// The API allows ranges up to 3,660 days.
	{ key: "all", label: "All time", days: 3660 },
];

function readSettings() {
	return {
		url: (Spicetify.LocalStorage.get(STORAGE.url) || "").replace(/\/+$/, ""),
		token: Spicetify.LocalStorage.get(STORAGE.token) || "",
	};
}

/** Today in the client's zone, minus `back` days, as YYYY-MM-DD. */
function localDay(back = 0) {
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
	const date = new Date(`${today}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() - back);
	return date.toISOString().slice(0, 10);
}

class ApiError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

/**
 * GET a warehouse route. Plain fetch, not CosmosAsync: CosmosAsync would attach
 * the Spotify session token and route a non-Spotify URL through Spicetify's
 * proxy. A stat still being computed answers 503 with Retry-After; wait once.
 */
async function api(path, { url, token }, retried = false) {
	let response;
	try {
		response = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
	} catch {
		throw new ApiError("Couldn't reach the warehouse. Check the URL, and that it allows https://xpui.app.spotify.com in CORS_ORIGINS.", 0);
	}
	if (response.status === 503 && !retried) {
		const wait = Math.min(Number(response.headers.get("Retry-After")) || 5, 30);
		await new Promise((resolve) => setTimeout(resolve, wait * 1000));
		return api(path, { url, token }, true);
	}
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const message = response.status === 401 ? "The warehouse refused the token. Paste a new one in Settings." : body.error || `HTTP ${response.status}`;
		throw new ApiError(message, response.status);
	}
	return body;
}

/** `{ data, error, loading }` for one API path; refetches when the path or settings change. */
function useApi(path, settings) {
	const [state, setState] = useState({ data: null, error: null, loading: true });
	useEffect(() => {
		let live = true;
		setState((previous) => ({ ...previous, loading: true }));
		api(path, settings).then(
			(data) => live && setState({ data, error: null, loading: false }),
			(error) => live && setState({ data: null, error, loading: false }),
		);
		return () => {
			live = false;
		};
	}, [path, settings.url, settings.token]);
	return state;
}

function play(uri) {
	Spicetify.Player.playUri(uri);
}

function openArtist(id) {
	Spicetify.Platform.History.push(`/artist/${id}`);
}

function Section({ title, children, aside }) {
	return h(
		"section",
		{ className: "mw-section" },
		h("div", { className: "mw-section-head" }, h("h2", null, title), aside),
		children,
	);
}

function Status({ state, empty }) {
	if (state.error) return h("p", { className: "mw-error" }, state.error.message);
	if (state.loading && !state.data) return h("p", { className: "mw-muted" }, "Loading…");
	if (empty) return h("p", { className: "mw-muted" }, "Nothing here yet.");
	return null;
}

/** Fourteen days of plays as tiny bars, oldest first. */
function Sparkline({ daily }) {
	const max = Math.max(1, ...daily);
	return h(
		"div",
		{ className: "mw-spark", "aria-hidden": true },
		daily.map((plays, index) => h("span", { key: index, style: { height: `${Math.max(2, (plays / max) * 100)}%` } })),
	);
}

function OnRepeat({ settings }) {
	const state = useApi("/api/stats/on-repeat", settings);
	const tracks = state.data?.tracks ?? [];
	return h(
		Section,
		{ title: "On repeat", aside: h("span", { className: "mw-muted" }, "Last 14 days") },
		h(Status, { state, empty: state.data && tracks.length === 0 }),
		h(
			"div",
			{ className: "mw-cards" },
			tracks.map((track) =>
				h(
					"button",
					{ key: track.track_id, className: "mw-card", onClick: () => play(`spotify:track:${track.track_id}`), title: `Play ${track.name}` },
					track.image ? h("img", { src: track.image, alt: "", loading: "lazy" }) : h("div", { className: "mw-art-empty" }),
					h("div", { className: "mw-card-name" }, track.name),
					h("div", { className: "mw-muted mw-ellipsis" }, track.artists),
					h("div", { className: "mw-card-foot" }, h("span", null, `${track.plays} plays · ${track.days} days`), h(Sparkline, { daily: track.daily })),
				),
			),
		),
	);
}

function TopTracks({ settings, query }) {
	const state = useApi(`/api/top-tracks?${query}&limit=20`, settings);
	const tracks = state.data?.tracks ?? [];
	return h(
		Section,
		{ title: "Top songs" },
		h(Status, { state, empty: state.data && tracks.length === 0 }),
		h(
			"ol",
			{ className: "mw-list" },
			tracks.map((track, index) =>
				h(
					"li",
					{ key: track.id },
					h(
						"button",
						{ className: "mw-row", onClick: () => play(`spotify:track:${track.id}`), title: `Play ${track.name}` },
						h("span", { className: "mw-rank" }, index + 1),
						track.image ? h("img", { src: track.image, alt: "", loading: "lazy" }) : h("div", { className: "mw-art-empty" }),
						h("span", { className: "mw-row-text" }, h("span", { className: "mw-ellipsis" }, track.name), h("span", { className: "mw-muted mw-ellipsis" }, track.artist)),
						h("span", { className: "mw-plays" }, track.plays.toLocaleString()),
					),
				),
			),
		),
	);
}

function TopArtists({ settings, query }) {
	const state = useApi(`/api/top-artists?${query}&limit=20`, settings);
	const artists = state.data?.artists ?? [];
	return h(
		Section,
		{ title: "Top artists" },
		h(Status, { state, empty: state.data && artists.length === 0 }),
		h(
			"ol",
			{ className: "mw-list" },
			artists.map((artist, index) =>
				h(
					"li",
					{ key: artist.artist_id ?? artist.name },
					h(
						"button",
						{
							className: "mw-row",
							// Artists known only from the export have no id, so nowhere to open.
							disabled: !artist.artist_id,
							onClick: () => openArtist(artist.artist_id),
							title: artist.artist_id ? `Open ${artist.name}` : undefined,
						},
						h("span", { className: "mw-rank" }, index + 1),
						h("div", { className: "mw-art-empty mw-round" }, artist.name.slice(0, 1)),
						h("span", { className: "mw-row-text" }, h("span", { className: "mw-ellipsis" }, artist.name)),
						h("span", { className: "mw-plays" }, artist.plays.toLocaleString()),
					),
				),
			),
		),
	);
}

function Overview({ settings }) {
	const [rangeKey, setRangeKey] = useState(() => Spicetify.LocalStorage.get(STORAGE.range) || "4w");
	const range = RANGES.find((candidate) => candidate.key === rangeKey) ?? RANGES[0];
	const query = `from=${localDay(range.days - 1)}&to=${localDay()}&tz=${encodeURIComponent(TZ)}`;
	const choose = (key) => {
		Spicetify.LocalStorage.set(STORAGE.range, key);
		setRangeKey(key);
	};
	return h(
		react.Fragment,
		null,
		h(OnRepeat, { settings }),
		h(
			"div",
			{ className: "mw-chips", role: "tablist" },
			RANGES.map((candidate) =>
				h(
					"button",
					{ key: candidate.key, role: "tab", "aria-selected": candidate.key === range.key, className: "mw-chip", onClick: () => choose(candidate.key) },
					candidate.label,
				),
			),
		),
		h("div", { className: "mw-columns" }, h(TopTracks, { settings, query }), h(TopArtists, { settings, query })),
	);
}

function Settings({ settings, onSave, onCancel }) {
	const [url, setUrl] = useState(settings.url);
	const [token, setToken] = useState(settings.token);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState(null);
	const cleanUrl = url.trim().replace(/\/+$/, "");

	const save = async (event) => {
		event.preventDefault();
		setChecking(true);
		setError(null);
		const next = { url: cleanUrl, token: token.trim() };
		try {
			// Any cheap read proves the URL, CORS and the token at once.
			await api(`/api/top-artists?limit=1&from=${localDay()}&to=${localDay()}`, next);
			Spicetify.LocalStorage.set(STORAGE.url, next.url);
			Spicetify.LocalStorage.set(STORAGE.token, next.token);
			onSave(next);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setChecking(false);
		}
	};

	return h(
		"form",
		{ className: "mw-settings", onSubmit: save },
		h("h2", null, "Connect your warehouse"),
		h(
			"p",
			{ className: "mw-muted" },
			"Enter your warehouse's URL, then sign in with Spotify there to get a read token and paste it below. The token is kept in this client's local storage, which other Spicetify extensions can read; it only reads, and you can revoke it from /admin/tokens.",
		),
		h("label", null, "Warehouse URL", h("input", { type: "url", required: true, placeholder: "https://warehouse.example.com", value: url, onChange: (event) => setUrl(event.target.value) })),
		cleanUrl &&
			h(
				"p",
				null,
				h("a", { href: `${cleanUrl}/auth/login?name=${encodeURIComponent("Spicetify")}`, target: "_blank", rel: "noreferrer" }, "Sign in with Spotify to get a token ↗"),
			),
		h("label", null, "Read token", h("input", { type: "password", required: true, autoComplete: "off", value: token, onChange: (event) => setToken(event.target.value) })),
		error && h("p", { className: "mw-error" }, error),
		h(
			"div",
			{ className: "mw-actions" },
			onCancel && h("button", { type: "button", className: "mw-chip", onClick: onCancel }, "Cancel"),
			h("button", { type: "submit", className: "mw-chip mw-primary", disabled: checking }, checking ? "Checking…" : "Save"),
		),
	);
}

function App() {
	const [settings, setSettings] = useState(readSettings);
	const configured = Boolean(settings.url && settings.token);
	const [editing, setEditing] = useState(!configured);
	const save = useCallback((next) => {
		setSettings(next);
		setEditing(false);
	}, []);

	return h(
		"div",
		{ className: "mw-app" },
		h(
			"header",
			{ className: "mw-header" },
			h("h1", null, "Warehouse"),
			configured && !editing && h("button", { className: "mw-chip", onClick: () => setEditing(true) }, "Settings"),
		),
		editing ? h(Settings, { settings, onSave: save, onCancel: configured ? () => setEditing(false) : null }) : h(Overview, { settings }),
	);
}

function render() {
	return h(App);
}
