# artifacts

Password-gated artifact hosting on Cloudflare: upload an HTML page or a PDF,
share a link, and nobody sees the content without the password. R2 for storage,
one Worker in front of it. Free tier, $0 at our volume.

```
artifacts/
├── src/
│   ├── index.ts        # the Worker: routing, the single auth gate, the single R2 read
│   ├── artifacts.ts    # THE ACL — which keys exist and what guards them
│   ├── auth.ts         # stateless signed session cookies (HMAC, no KV)
│   └── login.ts        # the login page served on every denial
├── scripts/
│   ├── upload.ts       # upload with the correct Content-Type
│   └── guard.ts        # post-deploy proof that an unauthed request gets nothing
└── wrangler.toml
```

## The guarantee

Not "we remember to protect the private ones" — the architecture makes leaking
take a deliberate act:

1. **The bucket is private.** No public access, `r2.dev` disabled, **no custom
   domain on the bucket**. The custom domain points at the *Worker*. With no
   public route to the bucket, there is physically no way to reach an object
   except through this Worker.
2. **One gate, one read.** `src/index.ts` contains exactly one
   `env.BUCKET.get()`, and every path to it passes one cookie check whose
   default branch is deny. Not an allowlist of protected paths — a single
   funnel.
3. **Unlisted keys 404.** Uploading a file doesn't publish it; you add a line to
   `artifacts.ts`. A forgotten artifact is locked, not exposed — the opposite of
   a deny-list, where forgetting means a leak. `public: true` is an explicit
   opt-in that's loud in a diff.
4. **Cookies are scoped.** A cookie is an HMAC over *scope + expiry*, so the
   password for the demo page does not open the Q3 deck. Sharing an unlock
   across several artifacts means giving them the same `group`, deliberately.
5. **Nothing is enforced in the browser.** An unauthorised request never
   receives a byte of artifact content, so `curl` and view-source see the login
   page too. (Client-side "hide it until they type the password" is theatre —
   the content already shipped.)
6. **Gated responses are `no-store`.** A cached 200 replayed to an
   unauthenticated request is the classic way this design leaks, so authed
   responses are never cacheable at the edge. (Cost of that: every reload hits
   the Worker.)

## Setup

```bash
pnpm install
pnpm exec wrangler login

# 1. the bucket — private, and keep it that way
pnpm exec wrangler r2 bucket create caddie-artifacts

# 2. secrets
openssl rand -base64 32 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put PW_DEMO        # one per artifact or group

# 3. point a custom domain at the WORKER (routes in wrangler.toml), then
pnpm --filter @caddie/artifacts deploy
```

Passwords are long and random, not `wedding2026`: a static password behind
100k req/day is brute-forceable in principle, and there's no lockout.

## Publishing an artifact

```bash
# 1. upload (sets Content-Type from the extension — R2 does not sniff)
pnpm --filter @caddie/artifacts upload ./q3-deck.pdf --remote
pnpm --filter @caddie/artifacts upload ./demo --key demo --remote   # a whole directory

# 2. list it in src/artifacts.ts
#    "q3-deck.pdf": { password: "PW_Q3" },
#    "demo/":       { password: "PW_DEMO", index: "index.html" },

# 3. deploy + prove the gate still holds
pnpm --filter @caddie/artifacts deploy
pnpm --filter @caddie/artifacts guard
```

Until step 2 the key 404s, by design.

## Checks

```bash
pnpm --filter @caddie/artifacts test       # ACL + cookie logic, offline
pnpm --filter @caddie/artifacts typecheck
pnpm --filter @caddie/artifacts guard      # against the deployed Worker
```

`guard` is the deterministic check, and it belongs on every deploy — it fails
loudly the day someone flips the bucket public to debug something. It asserts,
with no cookie: 401 on a gated key *and* that a known string from the file is
absent from the response; 401 for a tampered cookie, a forged expiry and a wrong
password; 404 for an unlisted key; no `cf-cache-status: HIT` on an authed
response; and that the bucket's `r2.dev` URL does not serve the object. Env it
needs is documented at the top of `scripts/guard.ts`.

### Running it automatically

Two workflows, split by what they can actually prove:

| Workflow | Runs | Does |
|---|---|---|
| `.github/workflows/artifacts-test.yml` | PRs touching `artifacts/**` | typecheck + unit tests |
| `.github/workflows/artifacts-guard.yml` | nightly, push to `main`, manual | `guard` against the deployed Worker |

The guard is deliberately *not* a PR check: it hits the live Worker, which does
not have the PR's code, so a PR-time run would only ever tell you about
production. What it's for is drift after a merge — someone flips the bucket
public to debug something, the custom domain moves off the Worker route,
`r2.dev` gets re-enabled, a cache rule starts caching an authed response. None
of that shows up in a diff, so it needs a clock.

It stays inert until you point it at a deployment. Set these in repo settings:

- **Variables** — `ARTIFACT_ORIGIN` (`https://artifacts.example.com`),
  `GUARD_KEY`, and optionally `GUARD_OTHER_KEY`, `R2_PUBLIC_URL` (each enables
  one more check).
- **Secrets** — `GUARD_PASSWORD`, `GUARD_CANARY`.

Until those exist the guard job warns and skips on a push, and **fails** on a
scheduled or manual run — a nightly green tick has to mean "the gate held", not
"there was nothing to check".

## Two things worth knowing

**Put this on a separate registrable domain**, not a subdomain of a site that
matters. Arbitrary HTML+JS served from `yoursite.com` gets that origin's
cookies, `localStorage` and same-origin `fetch` — stored XSS by design, and
subdomains share cookie scope. Claude serves artifacts off
`claudeusercontent.com` for exactly this reason. The CSP `sandbox` directive
here is the second layer, not the first.

**Cost:** Workers free is 100k req/day, R2 free is 10 GB + 1M writes + 10M reads
and zero egress. One HMAC verify plus an R2 read is ~1ms against a 10ms CPU
limit. Watch out that every subresource is its own request (an HTML artifact
pulling 20 images = 21 requests) and `no-store` means no edge caching, so
reloads all hit the Worker. Set a billing alert anyway so a scraper can't
quietly push us onto the $5/mo plan.

**Alternative:** Cloudflare Access (Zero Trust) is free to 50 users and gives
real auth — email one-time PIN or Google — in front of a Worker route with no
auth code of ours. It needs each viewer's email allowlisted, so it doesn't fit
"share a link plus a shared password," but if the audience is a few known people
it's less code and stronger.
