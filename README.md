# Gradiate API
An all-in-one API for: 
 - HAC (Home Access Center)
 - PowerSchool SIS
Used by the app Gradiate:

[See App Repo](https://github.com/ruskcoder/gradiate-app)

[Visit Site](https://gradiate.com/)

More coming soon!

Want to add support for a new platform? See [core/README.md](core/README.md) — shared session handling, streaming progress, and route plumbing live in `core/`, so a platform only implements its own login + scraping. `hac-v2/` is the reference implementation.

## Running and deploying

The API is a Cloudflare Worker (`index.js`, configured in `wrangler.jsonc`). The docs site in `docs/dist` is served as static assets by the same Worker.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the secrets
npm run dev                      # wrangler dev on http://localhost:3000
npm test                         # unit tests (node --test)
npm run check                    # bundle without deploying
```

To deploy: set each secret once with `npx wrangler secret put NAME` (the names are in `.dev.vars.example`), run `npm run deploy`, try the `*.workers.dev` URL it prints, then uncomment `routes` in `wrangler.jsonc` and deploy again to move `api.gradiate.app` over.

Notes:
- The hourly push broadcast is a cron trigger (`triggers.crons`), not a timer.
- `PUSH_SUBREQUEST_BUDGET` caps the outbound calls per broadcast (Free plan: 50 per invocation). Raise it on the Paid plan.
- `HAC_FAST_PATH=verify` runs the fast HAC page reader alongside cheerio and logs any difference, to confirm it against real portals.

_Documentation in progress_

