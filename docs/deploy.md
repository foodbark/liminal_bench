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

**The zone used to override that.** `_headers` is honored on `liminal-bench.pages.dev`, but the
`liminalbench.net` zone had Cloudflare's default Browser Cache TTL of four hours, which rewrites
any lower `max-age` on files of the default-cached extensions (js, css, png, woff2; HTML and JSON
are not among them, which is why those alone came back `max-age=0`). Verified 2026-09-28 and
again 2026-10-30, the day the band shipped and a phone kept showing the old floating boxes under
the new page. Set that day (dashboard, the `liminalbench.net` zone, Caching, Configuration,
Browser Cache TTL: **Respect Existing Headers**) and checked from outside: `src/ui.js`,
`style.css` and `assets/backdrop.png` now come back `max-age=0, must-revalidate`. If the setting
is ever lost, a phone can hold old modules for up to four hours after a push; a private tab or
clearing site data gets the new ones at once.

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

Schema changes since the first deploy are one-off ALTERs noted in `db/schema.sql` beside the table (the posters' size column, 2026-10-10; the `x`, `y` position columns on notes and posters, 2026-10-27; the `moved` column on both and the `placed` table for moving paper, 2026-10-29, the tables from the schema file itself): run each once against the remote database before the code that needs it goes live, or a pin fails with a 500; one ALTER per `--command`, since the remote API refused two statements in one (2026-10-29). Done on production: the size column (2026-10-10), x and y (2026-10-28), moved and the placed table (2026-10-29).

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

## When the git build does not fire

On 2026-10-22 two pushes to master registered on GitHub but Cloudflare never built them. The
deployment list (`npx wrangler pages deployment list --project-name liminal-bench`) shows which
commit production is on; to deploy the current checkout's commit by hand:

```
npx wrangler pages deploy . --project-name liminal-bench --branch master --commit-hash $(git rev-parse HEAD)
```

Wrangler reads the bindings from `wrangler.toml` and leaves `node_modules`, dotfiles and the
wrangler state out of the upload. The builds fired again on their own later that day.

## 6. The aircraft feed (2026-10-21)

`functions/api/flights.js` serves the planes (src/flights.js). It asks three community feeds in
turn, adsb.lol, adsb.fi and OpenSky, and keeps one shared copy in D1 (the `kv` table, which the
Function makes on first use; it is in `db/schema.sql` too). From Cloudflare's shared egress
addresses the feeds are a poor bet: adsb.lol allows 500 calls a day per address and the Function
shares its address with the world, adsb.fi answers 403 to anything from a Worker, and OpenSky is
slow and times out. So the reliable path is a pusher on a machine with its own address, which the
feeds answer freely:

```
npx wrangler pages secret put FLIGHTS_PUSH_KEY     # any long random string
FLIGHTS_PUSH_KEY=<the same string> npm run push     # every 30 s, forever; on the LAN box or a Pi
```

The pusher (`tools/push_flights.py`) fetches the feed and POSTs it to `/api/flights`; while a
pushed copy is fresh the Function asks no feed, and when the pusher stops it goes back to asking
them itself, serving the last good copy, marked stale, for an hour when none answers. The always-on
pusher is a GitHub Actions workflow (`.github/workflows/push_flights.yml`): every five hours it
starts a job that pushes every 30 s for just under six, queued behind the one before, free on the
public repository; it needs the same string as a repository secret (`gh secret set FLIGHTS_PUSH_KEY`,
or Settings, Secrets and variables, Actions), and `gh workflow run "push flights"` starts it by hand. An OpenSky
account's API client raises its budget from 400 to 4000 credits a day and makes the limit
per account instead of per address:

```
npx wrangler pages secret put OPENSKY_CLIENT_ID
npx wrangler pages secret put OPENSKY_CLIENT_SECRET
```

Check a feed from the edge with `/api/flights?src=adsb.lol` (or `adsb.fi`, `opensky`): it asks that
feed directly and stores nothing. It takes the push key, since an open check path let anyone spend
the feeds' daily budgets from Cloudflare's addresses (2026-10-29):

```
curl -H "Authorization: Bearer $FLIGHTS_PUSH_KEY" 'https://liminalbench.net/api/flights?src=opensky'
```

`?diag` on the page names the source of what it is showing.

## 7. The board's watch (2026-10-30)

A poster is the one thing on the board that can be worse than rude, and the board's defenses are
after the fact: anyone can tear anything down, pins are limited, Cloudflare's CSAM Scanning Tool
is on for the zone (Caching, Configuration; it hashes images as they enter Cloudflare's cache and
checks them against the known databases, blocking the URL and mailing the account on a match).
What those cannot shorten is the time until someone looks. So `functions/api/_alert.js` mails the
board's keeper the moment a poster goes up, through the Email Sending REST API (Pages Functions
have no `send_email` binding): a plain text mail, subject `_THEBOARD_` so a mailbox filter can
file it, saying a poster went up, its number and size, the hour in Missoula, the pinner's hash
for the day and the count on the board, with the picture's URL and the board's to open when
ready. **No picture and nothing from it is in the mail**, by the user's call: it may be the kind
of thing nobody wants arriving on a phone in public or unprepared. It is sent after the answer
to the pinner (`waitUntil`), and a failure is logged and never felt on the page.

The same module keeps the poster pictures in Cloudflare's cache. A Function's response never
enters it on its own (every picture came back `cf-cache-status: DYNAMIC`, 2026-10-30), so the
scanner never saw a poster; `posters/[id].js` now puts each picture in through the Cache API as
it serves it, and a tear-down takes it out, from the answering data center at once and from all
of them by purging its URL. Honesty about the tool: it only knows images already in the
databases, and what reaches the server is a 160-pixel palette-snapped pixel-art version of a
photo, which fuzzy hashing was not made to see through. The mail is the real watch.

Setting it up, all in the dashboard and three secrets; without them the watch is silent and the
board works as before:

1. Compute & AI, Email Service, Email Sending: onboard `liminalbench.net` (it adds the SPF and
   DKIM records; a few minutes to propagate). The mail comes from `board@liminalbench.net`
   (`ALERT_FROM` overrides it).
2. My Profile, API Tokens, Create Custom Token: **Email Sending: Edit** on the account, and for the
   purge **Cache Purge: Purge** on the `liminalbench.net` zone. Nothing else. Anyone holding this
   token can send mail from the domain, so it lives only as a Pages secret.
3. The zone id is on the zone's Overview page. Then:

```
npx wrangler pages secret put WATCH_TOKEN     # the token
npx wrangler pages secret put ALERT_TO        # where the mail goes (a plus-address makes filtering easy)
npx wrangler pages secret put CF_ZONE_ID      # for the purge; leave it out and tear-downs clear only the local cache
```

`CF_ACCOUNT_ID` is in `wrangler.toml` (`[vars]`; it is not a secret). The secrets take effect on
the next deploy. Check it by pinning a poster of your own and tearing it down: the mail arrives
within seconds, and a second fetch of a picture's URL from outside answers `cf-cache-status: HIT`.
A local run reads the same names from `.dev.vars`, with `CF_API` pointing at a stand-in for
`api.cloudflare.com` to see the requests without sending anything.

Only posters are watched. A note is eighty characters of text that anyone can read on the board;
if the watch should cover them too, `notes.js` can call the same module.

## Rate limits and abuse

`functions/api/notes.js` allows three notes an hour per address (salted daily hash, no addresses
stored) and thirty an hour in total, 80 characters each, control characters stripped; tearing
down six an hour per address and sixty in all; moving paper is not limited (nothing is lost by
a move, and digging through the pile takes many); every poster pinned is mailed to the board's keeper (section 7). Nothing ages off the board: it holds forty pieces of paper and refuses
a pin past that. In front of all of it sits one Cloudflare WAF rate-limiting rule on the zone
(Security rules in the dashboard, 2026-10-30; no deploy): requests whose path equals `/api/notes`,
`/api/posters` or `/api/voicemail` are blocked (429) for ten seconds once an address sends more
than twenty in ten seconds. The Free plan's rate-limiting rules match on the path alone (no
request method), so the rule names the write endpoints exactly rather than `/api/*`: a visit
fetches every poster picture from `/api/posters/ID` and the flights feed every half minute, and
a rule over the whole prefix blocked the page itself; twenty leaves a person dragging paper
around one a second alone. The rule took a few minutes to start counting after deploy, so give
a check that long. If the board gets found, tighten the limits in the Function or the rule.
