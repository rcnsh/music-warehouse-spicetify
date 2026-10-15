// A Spicetify custom app over a music-warehouse Worker. It reads only the
// warehouse's /api/* routes, never Spotify's Web API, so Spotify's rate limits
// don't touch it. No build step: plain JS against Spicetify.React.

/** @type {typeof import("react")} */
const react = Spicetify.React;
const { useState, useEffect, useCallback } = react;
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


const TABS = [
	{ key: "", label: "Overview", page: Overview },
	{ key: "history", label: "History", page: History },
	{ key: "on-this-day", label: "On this day", page: OnThisDay },
	{ key: "albums", label: "Albums", page: Albums },
	{ key: "over-time", label: "Over time", page: OverTime },
	{ key: "wrapped", label: "Wrapped", page: Wrapped },
	{ key: "concerts", label: "Concerts", page: Concerts },
];

/** The page for /warehouse/<tab> or /warehouse/<artist|track>/<id>. */
function route(pathname, settings) {
	const [, , section = "", id] = pathname.split("/");
	if (section === "artist" && id) return h(ArtistPage, { key: id, id: decodeURIComponent(id), settings });
	if (section === "track" && id) return h(TrackPage, { key: id, id: decodeURIComponent(id), settings });
	const tab = TABS.find((candidate) => candidate.key === section) ?? TABS[0];
	return h(tab.page, { settings });
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
					route(pathname, settings),
				),
	);
}

function render() {
	return h(App);
}
