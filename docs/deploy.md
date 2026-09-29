# Deploying: Cloudflare Pages, the notes API, the domain

Decided 2026-09-23: host, API and DNS all in one Cloudflare account, so the bulletin board's API
sits on the same origin under `/api/*` and CORS never comes up. `master` stays production: Pages
builds on every push exactly the way GitHub Pages does, with no build command and the repo root
as the output directory.

What is in the repo already (2026-09-28):

- `functions/api/notes.js`: the board's `GET`/`POST`, a Pages Function. Pages picks up a
  `functions/` directory automatically; nothing to configure beyond the D1 binding.
- `db/schema.sql`: the one table it uses.
- `wrangler.toml`: the Pages project config with the D1 binding. Pages reads it on git builds
  (and `wrangler pages dev` reads it locally) once the `database_id` is filled in.
- `src/notes.js`: the page probes `api/notes` at load. Where it answers, the board is shared;
  where it is missing (GitHub Pages, `npm run dev`), notes stay in the browser's localStorage.

Done on 2026-09-28 (evening): logged in (account `Foodbark@gmail.com's Account`), D1 database
`liminal-bench` created (id in `wrangler.toml`) and the schema loaded remotely, `SALT` secret set,
Pages project `liminal-bench` connected to git and building `master`, `liminalbench.net` registered
and attached with `www`. Later that evening the board work was pushed and verified live:
`https://liminalbench.net/api/notes` answers `[]`, the board panel shows shared mode, http
redirects to https, `www` resolves. Still to do: register `aplacesortof.net` and set its
redirect (section 4, step 2; it did not resolve on Sept 28), then section 5.

`_headers` at the repo root sets the cache policy: Pages otherwise caches every static file
for four hours in the browser while the HTML and JSON are revalidated on each load, and a phone
that visited before a push then mixes old modules with new ones and breaks on the first changed
import (seen 2026-09-28, the evening the board work shipped). Modules, assets and the stylesheet
now revalidate on every load (ETags make that a 304), and `/api/*` is never stored.

A note on stray paths: Pages serves `index.html` for anything that is not a file or a function
(`/api/notes/nope` returns the page with a 200), which is harmless here.

## 1. The database (once)

```
npx wrangler login
npx wrangler d1 create liminal-bench          # prints the database_id: paste it into wrangler.toml
npx wrangler d1 execute liminal-bench --remote --file=db/schema.sql
npx wrangler pages project create liminal-bench   # or make it in the dashboard, next step
npx wrangler pages secret put SALT            # any long random string; salts the per-address rate-limit hash
```

The salt is optional (the function falls back to a constant) but without it the daily hashes are
guessable, which only matters if someone wants to know whether two notes came from one address.

## 2. The Pages project

Dashboard: Workers & Pages, Create, Pages, Connect to Git, pick `foodbark/liminal_bench`,
production branch `master`, framework preset None, build command empty, build output directory
`/`. Save and deploy. The first build serves the site at `liminal-bench.pages.dev`.

With `wrangler.toml` in the repo the D1 binding comes along with the build; if the dashboard shows
the binding missing, add it under Settings, Bindings: D1 database, variable name `DB`, database
`liminal-bench`. Redeploy after.

Check: open `https://liminal-bench.pages.dev/api/notes` and expect `[]`. Then pin a note from the
board and reload. The board panel says "Anyone who stops here can read these." in shared mode and
"Whatever you pin stays in this browser" in local mode, so the mode is visible on the page.

## 3. Local runs with the API

`npm run dev` has no API (the board is single-player, which is fine for rendering work). For the
API path:

```
npx wrangler d1 execute liminal-bench --local --file=db/schema.sql
npx wrangler pages dev . --port 8788
```

and open http://127.0.0.1:8788/. The local D1 lives under `.wrangler/` (gitignored).

## 4. The domains

Two names, decided 2026-09-28: `liminalbench.net` is what the site is called, and
`aplacesortof.net` is Missoula's unofficial slogan ("Missoula: a place, sort of"), which is the
whole mood of the thing. Both were unregistered on the morning of Sept 28 (RDAP 404), and so were `aplacesortof.com`,
`aplacesortof.org`, `liminalbench.com` and `placesortof.net`. Both are bought as `.net` on
purpose: it has the retro feel the site is after. The `.com`s are optional insurance against a
lookalike, not part of the plan.

**One canonical name, everything else redirects to it.** Two domains serving the same page means
two URLs for one board, two sets of localStorage notes, and split search results. Canonical is
`liminalbench.net`; `aplacesortof.net` (and any `.com`) 301s to it, path preserved, so
`aplacesortof.net/?debug` lands on `liminalbench.net/?debug`.

Register both at Cloudflare (Domain Registration, Register Domains; registration is at
cost and each one becomes a zone in the account automatically). Step 1 is done; step 2 is not. Then:

1. Canonical: in the Pages project, Custom domains, Set up a custom domain, `liminalbench.net`.
   Add `www.liminalbench.net` there too; Cloudflare writes the records and the certificate.
2. `aplacesortof.net`, in its own zone:
   - DNS: one proxied record so the zone answers, `AAAA @ 100::` and `AAAA www 100::` (the
     orange cloud on, the address is a placeholder; the redirect rule fires before any origin).
   - Rules, Redirect Rules, Create rule: name "to liminalbench", expression
     `(http.host eq "aplacesortof.net") or (http.host eq "www.aplacesortof.net")`, type Dynamic,
     expression `concat("https://liminalbench.net", http.request.uri.path)`, status 301,
     preserve query string on. Deploy.
   - SSL/TLS: Full (the zone has no origin, but a certificate is issued for the proxied name and
     that is all the redirect needs).
3. Check: `curl -sI https://aplacesortof.net/?x=1` returns `301` with
   `location: https://liminalbench.net/?x=1`, and `https://liminalbench.net/api/notes` gives `[]`.

Nothing in the code assumes the `/liminal_bench/` path or any host: every asset and API URL is
relative, and `notes.js` probes `api/notes` relative to the page. If the canonical choice ever
flips, it is one Pages custom-domain change and one redirect rule, no deploy.

## 5. Retiring GitHub Pages

Keep it up until the Cloudflare deployment has been used for a few days. Then leave a redirect:
GitHub Pages cannot redirect on its own, so switch the repo's Pages source (Settings, Pages) from
`master` to a `gh-pages` branch that holds a single `index.html`:

```html
<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=https://liminalbench.net/">
<link rel="canonical" href="https://liminalbench.net/"><title>moved</title><a href="https://liminalbench.net/">liminal bench has moved</a>
```

Then update the URL in README.md and CLAUDE.md.

## Rate limits and abuse

`functions/api/notes.js` allows three notes an hour per address (salted daily hash, no addresses
stored) and thirty an hour in total, 80 characters each, control characters stripped. The board
shows six; anything older than sixteen days is off the board and is deleted on the next post. If
the board gets found, tighten `PER_ADDRESS_HOUR` and `ALL_HOUR` there, or put Cloudflare's WAF
rate-limiting rule on `/api/notes` in the dashboard, which needs no deploy.
