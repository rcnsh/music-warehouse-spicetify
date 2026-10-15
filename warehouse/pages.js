// One component per tab or detail page. See components.js for the rule about
// top-level code across the three files.

// --- Overview ---------------------------------------------------------------

const RANGES = [
	{ key: "4w", label: "4 weeks", days: 28 },
	{ key: "6m", label: "6 months", days: 182 },
	{ key: "1y", label: "Year", days: 365 },
	// The API allows ranges up to 3,660 days.
	{ key: "all", label: "All time", days: 3660 },
];

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
				h(Card, {
					key: track.track_id,
					image: track.image,
					title: track.name,
					subtitle: track.artists,
					onOpen: () => go(trackPath(track.track_id)),
					playUri: `spotify:track:${track.track_id}`,
					foot: [h("span", { key: "text" }, `${track.plays} plays · ${track.days} days`), h(Sparkline, { key: "spark", daily: track.daily })],
				}),
			),
		),
	);
}

function JumpBackIn({ settings }) {
	const state = useApi(`/api/home?tz=${encodeURIComponent(TZ)}`, settings);
	const items = (state.data?.jump_back_in ?? []).filter((item) => item.name).slice(0, 12);
	if (!state.error && state.data && items.length === 0) return null;
	return h(
		Section,
		{ title: "Jump back in" },
		h(Status, { state }),
		h(
			"div",
			{ className: "mw-cards mw-cards-small mw-cards-row" },
			items.map((item) =>
				h(Card, {
					key: item.uri,
					image: item.image,
					round: item.type === "artist",
					title: item.name,
					subtitle: item.artist ?? item.type,
					playUri: item.uri,
					foot: formatWhen(item.last_played_ms),
				}),
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
			"div",
			{ className: "mw-list" },
			tracks.map((track, index) => h(TrackRow, { key: track.id, index: index + 1, id: track.id, name: track.name, artist: track.artist, image: track.image, value: formatNumber(track.plays) })),
		),
	);
}

function TopArtists({ settings, query }) {
	const state = useApi(`/api/top-artists?${query}&limit=20`, settings);
	const artists = state.data?.artists ?? [];
	const resolved = useArtists(artists.map((artist) => artist.artist_id));
	return h(
		Section,
		{ title: "Top artists" },
		h(Status, { state, empty: state.data && artists.length === 0 }),
		h(
			"div",
			{ className: "mw-list" },
			artists.map((artist, index) =>
				h(ArtistRow, { key: artist.artist_id, index: index + 1, id: artist.artist_id, name: artist.name, resolved: resolved.get(artist.artist_id), value: formatNumber(artist.plays) }),
			),
		),
	);
}

/** Share of plays by hour in the current era, and the running streaks. */
function Rhythm({ settings }) {
	const state = useApi("/api/stats/rhythm", settings);
	const era = state.data?.eras?.at(-1);
	const weekly = state.data?.streaks?.find((streak) => streak.threshold === 1);
	if (!state.data) return h(Section, { title: "Listening clock" }, h(Status, { state }));
	return h(
		Section,
		{ title: "Listening clock", aside: era && h("span", { className: "mw-muted" }, `${era.label}, since ${formatMonth(era.from)}`) },
		era?.hour_share &&
			h(BarChart, {
				bars: era.hour_share.map((share, hour) => ({ label: `${String(hour).padStart(2, "0")}`, value: share, title: `${String(hour).padStart(2, "0")}:00 — ${(share * 100).toFixed(1)}% of plays` })),
				labelEvery: 3,
				height: 100,
				format: (share) => `${(share * 100).toFixed(1)}%`,
			}),
		weekly &&
			h(Stats, {
				items: [
					["Weeks in a row with a play", formatNumber(weekly.current_weeks)],
					weekly.longest && ["Longest run, in weeks", formatNumber(weekly.longest.weeks)],
					["Weeks with any listening", `${Math.round(weekly.active_share * 100)}%`],
				],
			}),
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
		h(JumpBackIn, { settings }),
		h(Chips, { options: RANGES, value: range.key, onChange: choose }),
		h("div", { className: "mw-columns" }, h(TopTracks, { settings, query }), h(TopArtists, { settings, query })),
		h(Rhythm, { settings }),
	);
}

// --- History ----------------------------------------------------------------

function PlayRows({ plays }) {
	return h(
		"div",
		{ className: "mw-list" },
		plays.map((p) =>
			h(TrackRow, {
				key: `${p.played_at_ms}-${p.track_id}`,
				id: p.track_id,
				name: p.track_name,
				artist: p.artists,
				artistId: p.artist_list?.[0]?.id,
				image: p.image_url,
				detail: p.context_name && p.context_name !== p.album_name ? p.context_name : p.album_name,
				value: h(
					"span",
					{ className: "mw-play-meta" },
					p.first_play ? h("span", { className: "mw-badge" }, "First play") : p.play_number ? h("span", { className: "mw-muted" }, `#${formatNumber(p.play_number)}`) : null,
					h("span", null, formatWhen(p.played_at_ms)),
				),
			}),
		),
	);
}

/** Pages of /api/plays newest first; `filter` is extra query parameters. */
function usePlays(filter, settings, pageSize = 50) {
	const [pages, setPages] = useState({ plays: [], done: false, loading: true, error: null });
	const load = useCallback(
		async (before) => {
			setPages((previous) => ({ ...previous, loading: true }));
			try {
				const data = await api(`/api/plays?${filter}&limit=${pageSize}${before ? `&before=${before}` : ""}`, settings);
				setPages((previous) => ({
					plays: before ? [...previous.plays, ...data.plays] : data.plays,
					done: data.plays.length < pageSize,
					loading: false,
					error: null,
				}));
			} catch (error) {
				setPages((previous) => ({ ...previous, loading: false, error }));
			}
		},
		[filter, settings.url, settings.token],
	);
	useEffect(() => {
		setPages({ plays: [], done: false, loading: true, error: null });
		load();
	}, [load]);
	const more = () => load(pages.plays.at(-1)?.played_at_ms);
	return { ...pages, more };
}

function MoreButton({ pages }) {
	if (pages.done || pages.plays.length === 0) return null;
	return h("button", { className: "mw-chip mw-more", disabled: pages.loading, onClick: pages.more }, pages.loading ? "Loading…" : "Load more");
}

function History({ settings }) {
	const [input, setInput] = useState("");
	const [q, setQ] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setQ(input.trim()), 300);
		return () => clearTimeout(timer);
	}, [input]);
	const pages = usePlays(q ? `q=${encodeURIComponent(q)}` : "", settings);
	return h(
		Section,
		{ title: "History" },
		h("input", {
			className: "mw-search",
			type: "search",
			placeholder: "Search songs, albums and artists",
			value: input,
			onChange: (event) => setInput(event.target.value),
		}),
		h(Status, { state: { data: pages.plays.length ? pages : null, error: pages.error, loading: pages.loading }, empty: !pages.loading && pages.plays.length === 0 }),
		h(PlayRows, { plays: pages.plays }),
		h(MoreButton, { pages }),
	);
}

// --- On this day ------------------------------------------------------------

function OnThisDay({ settings }) {
	const [date, setDate] = useState(localDay());
	const state = useApi(`/api/on-this-day?date=${date}&tz=${encodeURIComponent(TZ)}`, settings);
	const years = state.data?.years ?? [];
	return h(
		Section,
		{
			title: "On this day",
			aside: h("input", { className: "mw-date", type: "date", value: date, max: localDay(), onChange: (event) => event.target.value && setDate(event.target.value) }),
		},
		h(Status, { state, empty: state.data && years.length === 0 }),
		years.map((year) =>
			h(
				"div",
				{ key: year.year, className: "mw-year" },
				h("h3", null, year.year, h("span", { className: "mw-muted" }, ` · ${formatNumber(year.plays)} plays`)),
				h(
					"div",
					{ className: "mw-list" },
					year.top_tracks.map((track, index) => h(TrackRow, { key: track.id, index: index + 1, id: track.id, name: track.name, artist: track.artist, image: track.image, value: formatNumber(track.plays) })),
				),
			),
		),
	);
}

// --- Albums -----------------------------------------------------------------

function Albums({ settings }) {
	const state = useApi("/api/stats/albums", settings);
	const [year, setYear] = useState("all");
	const years = state.data?.years ?? [];
	const albums = year === "all" ? (state.data?.albums ?? []) : (years.find((candidate) => candidate.year === year)?.albums ?? []);
	return h(
		Section,
		{ title: "Albums", aside: state.data && h("span", { className: "mw-muted" }, `Albums with at least ${state.data.min_songs} songs played`) },
		state.data &&
			h(Chips, {
				options: [{ key: "all", label: "All time" }, ...[...years].reverse().map((candidate) => ({ key: candidate.year, label: candidate.partial ? `${candidate.year} so far` : candidate.year }))],
				value: year,
				onChange: setYear,
			}),
		h(Status, { state, empty: state.data && albums.length === 0 }),
		h(
			"div",
			{ className: "mw-cards" },
			albums.map((album, index) =>
				h(Card, {
					key: `${album.name}-${album.artist}`,
					image: album.image,
					title: `${index + 1}. ${album.name}`,
					subtitle: album.artist,
					foot: `${formatNumber(album.plays)} plays · ${album.songs} songs · ${album.from === album.to ? formatMonth(album.from) : `${formatMonth(album.from)}–${formatMonth(album.to)}`}`,
				}),
			),
		),
	);
}

// --- Over time --------------------------------------------------------------

function OverTime({ settings }) {
	const state = useApi("/api/stats/top-over-time", settings);
	const [grain, setGrain] = useState("years");
	const periods = [...(state.data?.[grain] ?? [])].reverse();
	return h(
		Section,
		{ title: "Over time" },
		h(Chips, {
			options: [
				{ key: "years", label: "Years" },
				{ key: "quarters", label: "Quarters" },
			],
			value: grain,
			onChange: setGrain,
		}),
		h(Status, { state, empty: state.data && periods.length === 0 }),
		periods.map((period) =>
			h(
				"div",
				{ key: period.period, className: "mw-period" },
				h("h3", null, period.period, h("span", { className: "mw-muted" }, ` · ${formatNumber(period.plays)} plays${period.partial ? " so far" : ""}`)),
				h(
					"div",
					{ className: "mw-columns" },
					h(
						"div",
						{ className: "mw-shares" },
						period.artists.map((artist) =>
							h(
								"div",
								{ key: artist.name, className: "mw-share", ...rowProps(() => go(artistPath(`name:${artist.name}`))) },
								h("span", { className: "mw-ellipsis" }, artist.name),
								h("span", { className: "mw-share-bar" }, h("span", { style: { width: `${artist.share * 100}%` } })),
								h("span", { className: "mw-plays" }, `${Math.round(artist.share * 100)}%`),
							),
						),
					),
					h(
						"div",
						{ className: "mw-list" },
						period.tracks.map((track, index) =>
							h(TrackRow, { key: track.track_id, index: index + 1, id: track.track_id, name: track.name, artist: track.artist, image: track.image, value: formatNumber(track.plays) }),
						),
					),
				),
			),
		),
	);
}

// --- Wrapped ----------------------------------------------------------------

function WrappedSummary({ range, settings }) {
	const state = useApi(`/api/wrapped?from=${range.from}&to=${range.to}`, settings);
	const w = state.data;
	const resolved = useArtists((w?.top_artists ?? []).map((artist) => artist.id));
	if (!w) return h(Status, { state });
	const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
	return h(
		react.Fragment,
		null,
		h(Stats, {
			items: [
				["Minutes", formatNumber(w.totals.minutes)],
				["Plays", formatNumber(w.totals.plays)],
				["Days listened", `${formatNumber(w.totals.days_listened)} of ${formatNumber(w.range.days)}`],
				["Artists", formatNumber(w.totals.artists)],
				["Songs", formatNumber(w.totals.songs)],
				w.biggest_day && ["Biggest day", `${formatDate(w.biggest_day.date)}, ${formatNumber(w.biggest_day.minutes)} min`],
				w.streak && ["Longest streak", `${formatNumber(w.streak.days)} days`],
				w.listening_age && ["Listening age", formatNumber(w.listening_age.age)],
			],
		}),
		h(
			"div",
			{ className: "mw-columns" },
			h(
				Section,
				{ title: "Top artists" },
				h(
					"div",
					{ className: "mw-list" },
					w.top_artists.map((artist, index) =>
						h(ArtistRow, {
							key: artist.id,
							index: index + 1,
							id: artist.id,
							name: artist.name,
							resolved: resolved.get(artist.id),
							detail: artist.top_song && `Top song: ${artist.top_song}`,
							value: `${formatNumber(artist.minutes)} min`,
						}),
					),
				),
			),
			h(
				Section,
				{ title: "Top songs" },
				h(
					"div",
					{ className: "mw-list" },
					w.top_songs.map((song, index) =>
						h(TrackRow, {
							key: song.track_id,
							index: index + 1,
							id: song.track_id,
							name: song.name,
							artist: song.artist,
							artistId: song.artist_id,
							image: song.image,
							value: `${formatNumber(song.plays)} plays`,
						}),
					),
				),
			),
		),
		h(
			Section,
			{ title: "Top albums" },
			h(
				"div",
				{ className: "mw-cards mw-cards-small" },
				w.top_albums.map((album) => h(Card, { key: `${album.name}-${album.artist}`, image: album.image, title: album.name, subtitle: album.artist, foot: `${formatNumber(album.minutes)} min` })),
			),
		),
		h(
			Section,
			{ title: "Month by month" },
			h(BarChart, { bars: w.months.map((month) => ({ label: formatMonth(month.month).split(" ")[0], value: month.minutes, title: `${formatMonth(month.month)}: ${formatNumber(month.minutes)} min` })), height: 100, format: (value) => `${formatNumber(value)} min` }),
			h(
				"div",
				{ className: "mw-list" },
				w.months.map((month) =>
					h(TrackRow, {
						key: month.month,
						id: month.top_song_id,
						name: month.top_song ?? "—",
						artist: month.top_artist ?? "",
						artistId: month.top_artist_id,
						image: month.image,
						detail: formatMonth(month.month),
						value: `${formatNumber(month.minutes)} min`,
					}),
				),
			),
		),
		h(
			"div",
			{ className: "mw-columns" },
			h(
				Section,
				{ title: "By hour" },
				h(BarChart, { bars: w.hours.map((value, hour) => ({ label: String(hour).padStart(2, "0"), value })), labelEvery: 3, height: 90, format: (value) => `${formatNumber(value)} min` }),
			),
			h(
				Section,
				{ title: "By weekday" },
				h(BarChart, { bars: w.weekdays.map((value, day) => ({ label: weekdays[day], value })), height: 90, format: (value) => `${formatNumber(value)} min` }),
			),
		),
		w.discoveries &&
			h(
				Section,
				{ title: "Discoveries", aside: h("span", { className: "mw-muted" }, `${formatNumber(w.discoveries.artists)} new artists · ${formatNumber(w.discoveries.songs)} new songs`) },
				h(
					"div",
					{ className: "mw-cards mw-cards-small" },
					w.discoveries.top.map((artist) =>
						h(Card, { key: artist.id, image: artist.image, title: artist.name, foot: `${formatNumber(artist.minutes)} min`, onOpen: () => go(artistPath(artist.id)) }),
					),
				),
			),
	);
}

function Wrapped({ settings }) {
	const state = useApi("/api/wrapped/ranges", settings);
	const ranges = state.data?.ranges ?? [];
	const [chosen, setChosen] = useState(null);
	const range = ranges.find((candidate) => candidate.from === chosen) ?? ranges.find((candidate) => candidate.computed);
	return h(
		Section,
		{ title: "Wrapped" },
		h(Status, { state, empty: state.data && !range }),
		ranges.length > 0 &&
			h(Chips, {
				options: ranges.map((candidate) => ({
					key: candidate.from,
					label: candidate.label,
					// A read token can only open ranges the warehouse has already computed.
					disabled: !candidate.computed,
					title: candidate.computed ? undefined : "Not computed yet",
				})),
				value: range?.from,
				onChange: setChosen,
			}),
		range && h(WrappedSummary, { key: range.from, range, settings }),
	);
}

// --- Concerts ---------------------------------------------------------------

function Concerts({ settings }) {
	const state = useApi(`/api/concerts?tz=${encodeURIComponent(TZ)}`, settings);
	const [region, setRegion] = useState("all");
	const regions = state.data?.regions ?? [];
	const concerts = (state.data?.concerts ?? []).filter((concert) => region === "all" || concert.region === region);
	const week = Date.now() - 7 * 86_400_000;
	return h(
		Section,
		{ title: "Concerts", aside: h("span", { className: "mw-muted" }, "Upcoming, for the artists you play most") },
		regions.length > 1 &&
			h(Chips, {
				options: [{ key: "all", label: "Everywhere" }, ...regions.map((candidate) => ({ key: candidate.key, label: candidate.label }))],
				value: region,
				onChange: setRegion,
			}),
		h(Status, { state, empty: state.data && concerts.length === 0 }),
		h(
			"div",
			{ className: "mw-list" },
			concerts.map((concert) =>
				h(
					"a",
					{ key: concert.url, className: "mw-row mw-concert", href: concert.url, target: "_blank", rel: "noreferrer" },
					h("span", { className: "mw-concert-date" }, h("strong", null, formatDate(concert.date).replace(/ \d{4}$/, "")), h("span", { className: "mw-muted" }, concert.date.slice(0, 4))),
					h(
						"span",
						{ className: "mw-row-text" },
						h("span", { className: "mw-ellipsis" }, concert.artists, new Date(concert.first_seen).getTime() > week && h("span", { className: "mw-badge" }, "New")),
						h("span", { className: "mw-muted mw-ellipsis" }, [concert.name !== concert.artists && concert.name, concert.venue, concert.city, concert.time].filter(Boolean).join(" · ")),
					),
					h("span", { className: "mw-plays" }, concert.status === "onsale" ? "Tickets ↗" : concert.status),
				),
			),
		),
	);
}

// --- Detail pages -----------------------------------------------------------

function Hero({ image, round, kicker, title, subtitle, actions }) {
	return h(
		"div",
		{ className: "mw-hero" },
		h("div", { className: `mw-hero-art${round ? " mw-round" : ""}` }, h(Art, { src: image, round, label: title })),
		h("div", { className: "mw-hero-text" }, h("div", { className: "mw-muted" }, kicker), h("h1", null, title), subtitle && h("div", { className: "mw-hero-sub" }, subtitle), actions && h("div", { className: "mw-actions" }, actions)),
	);
}

function ArtistPage({ id, settings }) {
	const byName = id.startsWith("name:");
	const query = byName ? `name=${encodeURIComponent(id.slice(5))}` : `id=${encodeURIComponent(id)}`;
	const state = useApi(`/api/artist?${query}&tz=${encodeURIComponent(TZ)}`, settings);
	const resolved = useArtists([id]).get(id);
	const uri = artistUri(id, resolved);
	const pages = usePlays(byName ? `artist_name=${encodeURIComponent(id.slice(5))}` : `artist_id=${encodeURIComponent(id)}`, settings, 20);
	const a = state.data;
	return h(
		react.Fragment,
		null,
		h(Hero, {
			image: resolved?.large ?? resolved?.image,
			round: true,
			kicker: "Artist",
			title: a?.artist?.name ?? id.replace(/^name:/, ""),
			actions: uri && [
				h("button", { key: "play", className: "mw-chip mw-primary", onClick: () => play(uri) }, "▶ Play"),
				h("button", { key: "open", className: "mw-chip", onClick: () => openSpotifyArtist(uri) }, "Open in Spotify"),
			],
		}),
		h(Status, { state }),
		a &&
			h(Stats, {
				items: [
					["Plays", formatNumber(a.plays)],
					["Listened", formatHours(a.minutes)],
					["First played", formatDate(a.first_played)],
					["Last played", formatDate(a.last_played)],
				],
			}),
		a?.months?.length > 0 && h(Section, { title: "Plays by month" }, h(BarChart, { bars: monthBars(a.months), height: 110 })),
		a &&
			h(
				"div",
				{ className: "mw-columns" },
				h(
					Section,
					{ title: "Top songs" },
					h(
						"div",
						{ className: "mw-list" },
						a.top_tracks.map((track, index) => h(TrackRow, { key: track.id, index: index + 1, id: track.id, name: track.name, artist: a.artist.name, image: track.image, value: formatNumber(track.plays) })),
					),
				),
				h(Section, { title: "Recent plays" }, h(PlayRows, { plays: pages.plays }), h(MoreButton, { pages })),
			),
	);
}

function TrackPage({ id, settings }) {
	const state = useApi(`/api/track?id=${encodeURIComponent(id)}&tz=${encodeURIComponent(TZ)}`, settings);
	const pages = usePlays(`track_id=${encodeURIComponent(id)}`, settings, 20);
	const t = state.data;
	const artistId = pages.plays[0]?.artist_list?.[0]?.id;
	return h(
		react.Fragment,
		null,
		h(Hero, {
			image: t?.track?.image,
			kicker: "Song",
			title: t?.track?.name ?? "",
			subtitle: t && (artistId ? h("a", { className: "mw-link", onClick: () => go(artistPath(artistId)) }, t.track.artist) : t.track.artist),
			actions: [h("button", { key: "play", className: "mw-chip mw-primary", onClick: () => play(`spotify:track:${id}`) }, "▶ Play")],
		}),
		h(Status, { state }),
		t &&
			h(Stats, {
				items: [
					["Plays", formatNumber(t.plays)],
					["Listened", formatHours(t.minutes)],
					["First played", formatDate(t.first_played)],
					["Last played", formatDate(t.last_played)],
				],
			}),
		t?.months?.length > 1 && h(Section, { title: "Plays by month" }, h(BarChart, { bars: monthBars(t.months), height: 110 })),
		h(Section, { title: "Every play" }, h(PlayRows, { plays: pages.plays }), h(MoreButton, { pages })),
	);
}
