// Shared pieces for the pages. Spicetify concatenates this with index.js and
// pages.js into one script, so nothing at the top level may use another file's
// constants: only declarations, read later inside functions.

// --- Formatting -------------------------------------------------------------

function formatNumber(value) {
	return Number(value ?? 0).toLocaleString();
}

function formatHours(minutes) {
	const hours = minutes / 60;
	return hours >= 10 ? `${formatNumber(Math.round(hours))} hours` : `${hours.toFixed(1)} hours`;
}

/** "15 Oct 2026" from an ISO timestamp or a YYYY-MM-DD day. */
function formatDate(value) {
	if (!value) return "—";
	const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
	return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : TZ });
}

/** "Oct 2026" from YYYY-MM. */
function formatMonth(month) {
	return new Date(`${month}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "3 min ago", "Yesterday 21:04", or a date, for a play's epoch-ms. */
function formatWhen(ms) {
	const ago = Date.now() - ms;
	if (ago < 60_000) return "Just now";
	if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
	const time = new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: TZ });
	const day = (offset) => localDay(offset);
	const playedDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
	if (playedDay === day(0)) return `Today ${time}`;
	if (playedDay === day(1)) return `Yesterday ${time}`;
	return `${formatDate(playedDay)} ${time}`;
}

// --- Navigation -------------------------------------------------------------

/**
 * The app's own routes live under /warehouse; History is Spotify's router.
 * `preview` is what the link already shows (a name, art). It rides in the
 * history entry, back and forward included, so the page can show it at once.
 */
function go(path, preview) {
	Spicetify.Platform.History.push({ pathname: `/warehouse${path}`, state: preview ? { preview } : undefined });
}

/** The `preview` the link to this page passed to `go`, or null. */
function usePreview() {
	const [preview] = useState(() => Spicetify.Platform.History.location?.state?.preview ?? null);
	return preview;
}

function trackPath(id) {
	return `/track/${encodeURIComponent(id)}`;
}

function artistPath(id) {
	return `/artist/${encodeURIComponent(id)}`;
}

function play(uri) {
	Spicetify.Player.playUri(uri);
}

/** `spotify:artist:<id>` → Spotify's own page for that artist. */
function openSpotifyArtist(uri) {
	Spicetify.Platform.History.push(`/artist/${uri.split(":").pop()}`);
}

/** `url` if it is an https URL, else null, so a stored link can't run script. */
function safeExternalUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" ? parsed.href : null;
	} catch {
		return null;
	}
}

/** An in-app link: a real href for keyboard and screen readers, routed by Spotify's history. */
function AppLink({ path, preview, children }) {
	return h(
		"a",
		{
			className: "mw-link",
			href: `/warehouse${path}`,
			onClick: (event) => {
				event.preventDefault();
				event.stopPropagation();
				go(path, preview);
			},
		},
		children,
	);
}

/** The current pathname, re-rendering on every navigation. */
function usePathname() {
	const history = Spicetify.Platform.History;
	const [pathname, setPathname] = useState(history.location.pathname);
	useEffect(() => history.listen((location) => setPathname(location.pathname)), []);
	return pathname;
}

// --- Artist lookups ---------------------------------------------------------

// The warehouse has no artist images, and artists known only from the export
// have a `name:` placeholder instead of a Spotify id. Both are filled in from
// the client's own GraphQL (not the Web API): the artist entity query for a
// real id, and search with an exact name match for a placeholder, so a common
// name never opens the wrong artist. Cached in local storage: hits for good,
// misses for a day, and a failed lookup not at all.
let artistCacheMap = null;

const MISS_TTL_MS = 86_400_000;
const ARTIST_CACHE_SIZE = 500;
const ARTIST_LOOKUPS_AT_ONCE = 4;

function artistCache() {
	if (!artistCacheMap) {
		try {
			artistCacheMap = new Map(Object.entries(JSON.parse(Spicetify.LocalStorage.get(STORAGE.artists)) || {}));
		} catch {
			artistCacheMap = new Map();
		}
	}
	return artistCacheMap;
}

function saveArtistCache() {
	const cache = artistCache();
	// Keep the most recently used, so the cache can't grow forever.
	Spicetify.LocalStorage.set(STORAGE.artists, JSON.stringify(Object.fromEntries([...cache].slice(-ARTIST_CACHE_SIZE))));
}

/** Set `id`, moving it to the most recently used end. */
function touchArtist(cache, id, entry) {
	cache.delete(id);
	cache.set(id, entry);
}

/**
 * Whether a cache entry needs looking up: absent, a miss over a day old, a miss
 * from before misses were timestamped (null), or a hit from before `large`.
 */
function needsLookup(entry, now = Date.now()) {
	if (entry == null) return true;
	if ("missedAt" in entry) return !(now - entry.missedAt < MISS_TTL_MS);
	return !("large" in entry);
}

/** The `{ uri, image, large }` in a cache entry, or null for a miss. */
function cachedArtist(entry) {
	return entry && !("missedAt" in entry) ? entry : null;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * The `data` of a GraphQL response. Spicetify.GraphQL.Request usually resolves
 * with `{ errors }` rather than throwing, and that is a failure, not a miss.
 */
function graphqlData(response) {
	if (response?.errors?.length) throw new Error(`GraphQL: ${response.errors[0]?.message ?? "request failed"}`);
	return response?.data;
}

/** The smallest image at least `min` px wide, else the largest. */
function pickImage(sources, min = 80) {
	const sorted = [...(sources ?? [])].sort((a, b) => a.width - b.width);
	return (sorted.find((source) => source.width >= min) ?? sorted.at(-1))?.url ?? null;
}

const fold = (text) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** `{ uri, image, large }` for a warehouse artist id, or null if Spotify has no match. */
async function resolveArtist(id) {
	const queries = Spicetify.GraphQL?.Definitions ?? {};
	if (!id.startsWith("name:")) {
		const uri = `spotify:artist:${id}`;
		if (!queries.fetchExtractedColorAndImageForArtistEntity) return { uri, image: null, large: null };
		const data = graphqlData(await Spicetify.GraphQL.Request(queries.fetchExtractedColorAndImageForArtistEntity, { uri }));
		const sources = data?.artistUnion?.visuals?.avatarImage?.sources;
		return { uri, image: pickImage(sources), large: pickImage(sources, 300) };
	}
	if (!queries.searchModalResults) return null;
	const name = id.slice("name:".length);
	// The client's own search sends these flags; it fails without `includeAuthors`
	// (Spotify 1.3.5), and extra flags are ignored, so send every one it uses.
	const data = graphqlData(
		await Spicetify.GraphQL.Request(queries.searchModalResults, {
			searchTerm: name,
			offset: 0,
			limit: 10,
			numberOfTopResults: 10,
			includeAudiobooks: false,
			includePreReleases: false,
			includeAuthors: false,
			includeArtistHasConcertsField: false,
			includeEpisodeContentRatingsV2: false,
		}),
	);
	const results = data?.searchV2;
	const artists = [...(results?.topResultsV2?.itemsV2 ?? []).map((hit) => hit.item), ...(results?.artists?.items ?? [])]
		.map((item) => item?.data)
		.filter((entity) => entity?.__typename === "Artist");
	const match = artists.find((artist) => fold(artist.profile?.name ?? "") === fold(name));
	if (!match) return null;
	const sources = match.visuals?.avatarImage?.sources;
	return { uri: match.uri, image: pickImage(sources), large: pickImage(sources, 300) };
}

/**
 * Warehouse artist id → `{ uri, image, large }` or null, filled in as lookups
 * land. Returns `{ get(id) }`.
 */
function useArtists(ids) {
	const [, setVersion] = useState(0);
	const key = ids.join(",");
	useEffect(() => {
		let live = true;
		const cache = artistCache();
		const wanted = [...new Set(ids)].filter(Boolean);
		if (wanted.length === 0) return;
		const missing = wanted.filter((id) => needsLookup(cache.get(id)));
		for (const id of wanted) if (!missing.includes(id)) touchArtist(cache, id, cache.get(id));
		if (missing.length === 0) {
			saveArtistCache();
			return;
		}
		mapLimit(missing, ARTIST_LOOKUPS_AT_ONCE, (id) =>
			// Once the page is gone, the queue drains without asking Spotify.
			live
				? resolveArtist(id).then(
						(artist) => touchArtist(cache, id, artist ?? { missedAt: Date.now() }),
						// A failed lookup isn't cached, so the next visit tries again.
						() => {},
					)
				: null,
		).then(() => {
			saveArtistCache();
			if (live) setVersion((version) => version + 1);
		});
		return () => {
			live = false;
		};
	}, [key]);
	return { get: (id) => cachedArtist(artistCache().get(id)) };
}

/** The Spotify URI for a warehouse artist id, once known. */
function artistUri(id, resolved) {
	return resolved?.uri ?? (id && !id.startsWith("name:") ? `spotify:artist:${id}` : null);
}

// --- Layout -----------------------------------------------------------------

function Section({ title, children, aside }) {
	return h(
		"section",
		{ className: "mw-section" },
		(title || aside) && h("div", { className: "mw-section-head" }, h("h2", null, title), aside),
		children,
	);
}

function Status({ state, empty }) {
	if (state.error) return h("p", { className: "mw-error" }, state.error.message);
	if (state.loading && !state.data) return h("p", { className: "mw-muted" }, "Loading…");
	if (empty) return h("p", { className: "mw-muted" }, "Nothing here yet.");
	return null;
}

/** A row of pill buttons; `options` is `[{ key, label, disabled?, title? }]`. */
function Chips({ options, value, onChange }) {
	return h(
		"div",
		{ className: "mw-chips", role: "tablist" },
		options.map((option) =>
			h(
				"button",
				{
					key: option.key,
					role: "tab",
					"aria-selected": option.key === value,
					className: "mw-chip",
					disabled: option.disabled,
					title: option.title,
					onClick: () => onChange(option.key),
				},
				option.label,
			),
		),
	);
}

function Stats({ items }) {
	return h(
		"div",
		{ className: "mw-stats" },
		items.filter(Boolean).map(([label, value]) => h("div", { key: label, className: "mw-stat" }, h("div", { className: "mw-stat-value" }, value), h("div", { className: "mw-muted" }, label))),
	);
}

function Art({ src, round, label }) {
	const className = round ? "mw-round" : "";
	return src ? h("img", { src, alt: "", loading: "lazy", className }) : h("div", { className: `mw-art-empty ${className}` }, (label ?? "").slice(0, 1));
}

/** A clickable row that isn't a <button>, so it can hold a play button. */
function rowProps(onOpen) {
	return onOpen
		? {
				role: "link",
				tabIndex: 0,
				onClick: onOpen,
				onKeyDown: (event) => {
					// Ignore keys meant for a link or button inside the row.
					if (event.target !== event.currentTarget) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen();
					}
				},
			}
		: { "aria-disabled": true };
}

/** Rank that turns into a play button on hover. */
function PlayCell({ index, uri, label }) {
	if (!uri) return h("span", { className: "mw-rank" }, index ?? "");
	return h(
		"span",
		{ className: "mw-rank mw-play-cell" },
		index != null && h("span", { className: "mw-rank-number" }, index),
		h(
			"button",
			{
				className: "mw-play",
				title: `Play ${label}`,
				"aria-label": `Play ${label}`,
				onClick: (event) => {
					event.stopPropagation();
					play(uri);
				},
			},
			"▶",
		),
	);
}

/** "A, B, C", each artist with an id linking to their own page. */
function ArtistLinks({ artists }) {
	return artists.map((artist, index) =>
		h(
			react.Fragment,
			{ key: `${index}:${artist.id}` },
			index > 0 && ", ",
			artist.id ? h(AppLink, { path: artistPath(artist.id), preview: { name: artist.name } }, artist.name) : artist.name,
		),
	);
}

/**
 * One song. `id` opens its page and plays it. `artists` ({ id, name }[]) links
 * each artist; `artistId` links `artist` as one. `songArtist` is who the song's
 * page shows while it loads: null when `artist` isn't the song's own.
 * `detail` sits under the title, after the artist; `value` on the right.
 */
function TrackRow({ index, id, name, artist, artists, artistId, songArtist = artist, image, detail, value }) {
	const linked = artists?.length ? artists : artistId ? [{ id: artistId, name: artist }] : null;
	return h(
		"div",
		{ className: "mw-row", ...rowProps(id ? () => go(trackPath(id), { name, artist: songArtist, image }) : null) },
		h(PlayCell, { index, uri: id && `spotify:track:${id}`, label: name }),
		h(Art, { src: image, label: name }),
		h(
			"span",
			{ className: "mw-row-text" },
			h("span", { className: "mw-ellipsis" }, name),
			h(
				"span",
				{ className: "mw-muted mw-ellipsis" },
				linked ? h(ArtistLinks, { artists: linked }) : artist,
				detail && ` · ${detail}`,
			),
		),
		value != null && h("span", { className: "mw-plays" }, value),
	);
}

/** One artist, opening its warehouse page. `resolved` comes from useArtists. */
function ArtistRow({ index, id, name, resolved, detail, value }) {
	return h(
		"div",
		{ className: "mw-row", ...rowProps(() => go(artistPath(id ?? `name:${name}`), { name, image: resolved?.image })) },
		h(PlayCell, { index, uri: artistUri(id, resolved), label: name }),
		h(Art, { src: resolved?.image, round: true, label: name }),
		h("span", { className: "mw-row-text" }, h("span", { className: "mw-ellipsis" }, name), detail && h("span", { className: "mw-muted mw-ellipsis" }, detail)),
		value != null && h("span", { className: "mw-plays" }, value),
	);
}

/** A square card: art, title, subtitle, foot. */
function Card({ image, round, title, subtitle, foot, onOpen, playUri }) {
	return h(
		"div",
		{ className: "mw-card", ...rowProps(onOpen ?? (playUri ? () => play(playUri) : null)) },
		h(
			"div",
			{ className: "mw-card-art" },
			h(Art, { src: image, round, label: title }),
			playUri &&
				h(
					"button",
					{
						className: "mw-card-play",
						title: `Play ${title}`,
						"aria-label": `Play ${title}`,
						onClick: (event) => {
							event.stopPropagation();
							play(playUri);
						},
					},
					"▶",
				),
		),
		h("div", { className: "mw-card-name" }, title),
		subtitle && h("div", { className: "mw-muted mw-ellipsis" }, subtitle),
		foot && h("div", { className: "mw-card-foot" }, foot),
	);
}

/**
 * Vertical bars. `bars` is `[{ label, value, title? }]`; every `labelEvery`th
 * label is printed under the chart.
 */
function BarChart({ bars, height = 120, labelEvery = 1, format = formatNumber }) {
	const max = Math.max(1, ...bars.map((bar) => bar.value));
	return h(
		"div",
		{ className: "mw-chart" },
		h(
			"div",
			{ className: "mw-chart-bars", style: { height } },
			bars.map((bar, index) =>
				h("span", {
					key: index,
					className: "mw-chart-bar",
					title: bar.title ?? `${bar.label}: ${format(bar.value)}`,
					style: { height: `${bar.value ? Math.max(2, (bar.value / max) * 100) : 0}%` },
				}),
			),
		),
		h(
			"div",
			{ className: "mw-chart-labels" },
			bars.map((bar, index) => h("span", { key: index }, index % labelEvery === 0 ? bar.label : "")),
		),
	);
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

/** Months → bars, with a label each January (or every month for short spans). */
function monthBars(months, value = (month) => month.plays) {
	return months.map((month) => ({ label: month.month.endsWith("-01") || months.length <= 12 ? formatMonth(month.month) : "", value: value(month), title: `${formatMonth(month.month)}: ${formatNumber(value(month))}` }));
}
