// A Spicetify custom app over a music-warehouse Worker. It reads only the
// warehouse's /api/* routes, never Spotify's Web API, so Spotify's rate limits
// don't touch it. No build step: plain JS against Spicetify.React.

/** @type {typeof import("react")} */
const react = Spicetify.React;
const { useState, useEffect, useCallback, useRef } = react;
const h = react.createElement;

const STORAGE = { url: "warehouse:url", token: "warehouse:token", range: "warehouse:range", artists: "warehouse:artists" };

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

const TIMEOUT_MS = 20_000;

/** Hosts that may be reached over plain http: this machine only. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `url` can't be a warehouse URL, or null if it can: https, or http to this machine. */
function warehouseUrlError(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return "Enter the warehouse's full URL, starting with https://.";
	}
	if (parsed.protocol === "https:") return null;
	if (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) return null;
	return "The warehouse URL must start with https:// (plain http is only allowed for localhost).";
}

/** Seconds to wait from a Retry-After header, or null if it has none it can use. */
function retryAfterSeconds(header) {
	if (header == null || header.trim() === "") return null;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) : null;
}

/** `signal` and a timeout together, as one signal. */
function withTimeout(signal) {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	if (!signal) return timeout;
	if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
	const controller = new AbortController();
	const abort = (source) => () => controller.abort(source.reason);
	signal.addEventListener("abort", abort(signal), { once: true });
	timeout.addEventListener("abort", abort(timeout), { once: true });
	return controller.signal;
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/**
 * GET a warehouse route. Plain fetch, not CosmosAsync: CosmosAsync would attach
 * the Spotify session token and route a non-Spotify URL through Spicetify's
 * proxy. A stat still being computed answers 503 with Retry-After; wait once.
 * A 503 with `needs_reauth` is the warehouse's Spotify grant, which waiting
 * won't fix. `signal` aborts the request; an abort rejects with its AbortError.
 */
async function api(path, { url, token }, { signal, retried = false } = {}) {
	const urlError = warehouseUrlError(url);
	if (urlError) throw new ApiError(urlError, 0);
	let response;
	try {
		response = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: withTimeout(signal) });
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error?.name === "TimeoutError") throw new ApiError(`The warehouse didn't answer within ${TIMEOUT_MS / 1000} seconds. Try again.`, 0);
		throw new ApiError("Couldn't reach the warehouse. Check the URL, and that it allows https://xpui.app.spotify.com in CORS_ORIGINS.", 0);
	}
	const body = await response.json().catch(() => ({}));
	if (response.status === 503) {
		if (body.needs_reauth) throw new ApiError("The warehouse's Spotify connection needs re-authorizing. Sign in to the warehouse again.", 503);
		const wait = retryAfterSeconds(response.headers.get("Retry-After"));
		if (wait != null && !retried) {
			await sleep(wait * 1000, signal);
			return api(path, { url, token }, { signal, retried: true });
		}
	}
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
		const controller = new AbortController();
		setState((previous) => ({ ...previous, loading: true }));
		api(path, settings, { signal: controller.signal }).then(
			(data) => !controller.signal.aborted && setState({ data, error: null, loading: false }),
			(error) => !controller.signal.aborted && setState({ data: null, error, loading: false }),
		);
		return () => controller.abort();
	}, [path, settings.url, settings.token]);
	return state;
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
			!warehouseUrlError(cleanUrl) &&
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


const TABS = [
	{ key: "", label: "Overview", page: Overview },
	{ key: "history", label: "History", page: History },
	{ key: "on-this-day", label: "On this day", page: OnThisDay },
	{ key: "albums", label: "Albums", page: Albums },
	{ key: "over-time", label: "Over time", page: OverTime },
	{ key: "wrapped", label: "Wrapped", page: Wrapped },
	{ key: "concerts", label: "Concerts", page: Concerts },
];

/** `decodeURIComponent`, or null for a malformed escape instead of throwing. */
function safeDecode(text) {
	try {
		return decodeURIComponent(text);
	} catch {
		return null;
	}
}

/** The page for /warehouse/<tab> or /warehouse/<artist|track>/<id>. */
function route(pathname, settings) {
	const [, , section = "", id] = pathname.split("/");
	if ((section === "artist" || section === "track") && id) {
		const decoded = safeDecode(id);
		if (decoded == null) return h(Section, { title: "Not found" }, h("p", { className: "mw-muted" }, "That link is malformed."));
		return h(section === "artist" ? ArtistPage : TrackPage, { key: id, id: decoded, settings });
	}
	const tab = TABS.find((candidate) => candidate.key === section) ?? TABS[0];
	return h(tab.page, { settings });
}

/** Catches a page that throws while rendering, so one bad response can't blank the app. */
class ErrorBoundary extends react.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error) {
		return { error };
	}

	componentDidCatch(error, info) {
		console.error("warehouse:", error, info?.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return h(
			Section,
			{ title: "Something went wrong" },
			h("p", { className: "mw-error" }, this.state.error.message || String(this.state.error)),
			h("button", { className: "mw-chip", onClick: () => this.setState({ error: null }) }, "Try again"),
		);
	}
}

function App() {
	const [settings, setSettings] = useState(readSettings);
	const configured = Boolean(settings.url && settings.token);
	const [editing, setEditing] = useState(!configured);
	const pathname = usePathname();
	const section = pathname.split("/")[2] ?? "";
	const save = useCallback((next) => {
		setSettings(next);
		setEditing(false);
	}, []);

	// Each page scrolls Spotify's main view back to the top when it opens.
	useEffect(() => {
		document.querySelector(".main-view-container__scroll-node, .os-viewport")?.scrollTo?.({ top: 0 });
	}, [pathname]);

	return h(
		"div",
		{ className: "mw-app" },
		h(
			"header",
			{ className: "mw-header" },
			h("h1", null, "Warehouse"),
			configured && !editing && h("button", { className: "mw-chip", onClick: () => setEditing(true) }, "Settings"),
		),
		editing
			? h(Settings, { settings, onSave: save, onCancel: configured ? () => setEditing(false) : null })
			: h(
					react.Fragment,
					null,
					h(
						"nav",
						{ className: "mw-tabs" },
						TABS.map((tab) =>
							h(
								"button",
								{ key: tab.key, className: "mw-tab", "aria-current": tab.key === section ? "page" : undefined, onClick: () => go(tab.key ? `/${tab.key}` : "") },
								tab.label,
							),
						),
					),
					// Keyed by path, so opening another page clears an error.
					h(ErrorBoundary, { key: pathname }, route(pathname, settings)),
				),
	);
}

function render() {
	return h(App);
}
