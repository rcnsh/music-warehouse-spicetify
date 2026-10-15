# music-warehouse-spicetify

A [Spicetify](https://spicetify.app) custom app that shows your listening stats
inside the Spotify desktop client, read from your own
[music-warehouse](https://github.com/rcnsh/music-warehouse).

It only calls the warehouse's `/api/*` routes, never Spotify's Web API, so
Spotify's rate limits and endpoint removals don't affect it. Plain JavaScript
against `Spicetify.React`, with no build step.

## What it shows

- **On repeat**: songs you're playing far more than usual over the last 14
  days, with a daily sparkline.
- **Top songs and artists** for the last 4 weeks, 6 months, year or all time,
  counted in the client's local timezone.

Click a song to play it, or an artist to open their page.

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
