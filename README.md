# music-warehouse-spicetify

A [Spicetify](https://spicetify.app) custom app that shows your listening stats
inside the Spotify desktop client, read from your own
[music-warehouse](https://github.com/rcnsh/music-warehouse).

It only calls the warehouse's `/api/*` routes, never Spotify's Web API, so
Spotify's rate limits and endpoint removals don't affect it. Plain JavaScript
against `Spicetify.React`, with no build step: `index.js` (shell, API,
routing), `components.js` and `pages.js`, concatenated by Spicetify.

It is one of several clients of the warehouse; the
[full list](https://github.com/rcnsh/music-warehouse#clients) is in its README.

## What it shows

| Tab | From |
|---|---|
| **Overview**: on repeat (with a 14-day sparkline), jump back in, top songs and artists for 4 weeks, 6 months, a year or all time, and a listening clock with your streak | `/api/stats/on-repeat`, `/api/home`, `/api/top-tracks`, `/api/top-artists`, `/api/stats/rhythm` |
| **History**: every play, newest first, searchable, with each one's play number or "first play" | `/api/plays` |
| **On this day**: what you played on a date in earlier years | `/api/on-this-day` |
| **Albums**: most-played albums, all time and per year | `/api/stats/albums` |
| **Over time**: top artists and songs per year or quarter | `/api/stats/top-over-time` |
| **Wrapped**: any range the warehouse has computed | `/api/wrapped` |
| **Concerts**: upcoming gigs for the artists you play most | `/api/concerts` |

Every song and artist opens a page of its own, with totals, plays by month,
top songs and recent plays (`/api/track`, `/api/artist`, `/api/plays`). Hover
a row for a play button; artist pages link to Spotify's own.

The warehouse has no artist images, and artists known only from the export
have no Spotify id (`name:…`). The app fills both in from the client's own
GraphQL, which the Spotify client itself uses. For a placeholder it searches by
name and takes only an exact match, so an artist with a common name stays
unlinked rather than opening the wrong page. Results, misses included, are
cached in local storage (`warehouse:artists`).

## Setup

### The warehouse

The app runs on the client's origin, `https://xpui.app.spotify.com`, so the
warehouse must allow it for CORS. Add it to `CORS_ORIGINS` (comma-separated)
alongside any other origins you use:

```bash
npx wrangler secret put CORS_ORIGINS   # e.g. https://xpui.app.spotify.com
```

If you block tokenless requests with a WAF rule, it must let `OPTIONS` through,
as the warehouse README describes.

### The app

With Spicetify installed:

```bash
git clone https://github.com/rcnsh/music-warehouse-spicetify && cd music-warehouse-spicetify
./install.sh
```

Or by hand: copy or link `warehouse/` into `$(spicetify path userdata)/CustomApps/`,
then `spicetify config custom_apps warehouse` and `spicetify apply`.

Open **Warehouse** in the client's top bar, enter your warehouse URL, follow
**Sign in with Spotify** to get a read token, and paste it in. The app checks
both before saving.

The token lives in the client's local storage, which other Spicetify
extensions can read. It is a read token: revoke it from `/admin/tokens` if you
stop using the app.

## After Spotify updates

A Spotify update removes Spicetify's patch. Run `spicetify backup apply` to
patch the new version.

## Uninstalling

```bash
spicetify config custom_apps warehouse-
spicetify apply
rm "$(spicetify path userdata)/CustomApps/warehouse"
```
