# c-check — Leak guard: two new safety rules

> Stop Claude Code from shipping an app whose login page leaks data.

Status: Plan (Oct 2026)
Owner: Ahmad
Builds on: `c-check-design.md` and `c-check-v0.2-design.md`. Everything in them still holds.

---

## 0. Read this first (for Claude Code)

1. Read `README.md`, `src/engine/types.ts`, `src/engine/engine.ts`, `src/adapter/register.ts`, `src/rules/tests-pass-before-done.ts`, `src/rules/tests-still-bite.ts`, `evals/replay.ts` and `tests/integration/harness.ts` before you write code.
2. Build **one phase at a time** (section 6). Stop at each phase's "Done when". Show the output. Then stop and report.
3. Use the Claude Code **mods** format only. All mods API code stays in `src/adapter/`.
4. If the mods API or `Ports` cannot do something this plan needs, stop. Write down what is missing. Ask Ahmad before you choose a workaround.
5. v0.1 ground rules still apply:
   - No runtime dependencies.
   - Fail open. A rule bug must never break Claude Code.
   - Silent when fine.
   - **Never log contents.** Never log a matched email, phone number, IC number or any response body. Log counts, detector names and routes only.
   - Prefer integration tests through the full chain. Add a unit test only when an integration test cannot reach the case.
6. Every check in this plan is deterministic. No phase calls a real model. If you ever think a step needs a paid model run, stop and ask Ahmad first.
7. Run `npm run typecheck && npm run test:unit && node evals/replay.ts` before you say a phase is done. One commit per phase, with a clear message.

---

## 1. The problem

A real case (MyBroadband, 16 Oct 2026): a dashboard built with Claude showed a login screen. But the server also sent company and personal data to the browser with that login page. Anyone with the link could read it in the page source. No login was needed.

c-check today does not catch this:

- No tests, so R1 only warns "No test command found."
- No secret key, so R4 sees nothing.
- Nothing outside the project, nothing destructive.

The code did what it was told. It was unsafe. Source: https://mybroadband.co.za/news/software/672602-south-african-coffee-franchise-exposes-company-and-private-data-in-vibe-coded-web-application.html

## 2. The two rules

| Rule                       | Point  | Kind     | Default mode |
| :------------------------- | :----- | :------- | :----------- |
| R10 `no-data-before-login` | end    | `safety` | `observe`    |
| R11 `deploy-gate`          | before | `safety` | `observe`    |

Both are `safety`: rare, costly, hard to undo. They are never retired.

---

## 3. R10 `no-data-before-login` (point: end)

**The idea.** Request the pages that need a login from the dev server the user already runs, **while logged out**. Scan what comes back for personal data. A page that needs a login must not send that data to a stranger.

c-check never starts or stops the app. Process management inside a mod is fragile, so it is out of scope.

### Config

```json
"no-data-before-login": {
  "mode": "observe",
  "port": 3000,
  "routes": ["/login", "/dashboard"],
  "allowEmails": ["support@example.com"]
}
```

- `port`: where the user's dev server runs. **Required.** Without it the rule allows and logs `skipped: "not configured"`.
- `routes`: pages that need a login. Only these are checked. Public pages (a contact page) are not listed, so they are never flagged.
- `allowEmails`: emails that may appear on these pages (a support address).

### Check

1. Skip when no source file changed since the last pass of this rule. Store the passing tree hash in session state (like `lastGreenTree` for R1).
2. For each route, run `ports.run(['curl', '-s', '-i', '--max-time', '10', 'http://127.0.0.1:<port><route>'])`. Build the URL only from the configured port, so it is always localhost. No `-L`, so redirects are not followed. No cookies, no auth header.
3. First request cannot connect → allow, log `skipped: "app not running"`. `curl` missing → allow, log `skipped: "curl not found"`.
4. Cut each body at 2 MB in the mod.
5. If the body is HTML, also curl up to 10 same-origin `<script src>` files it links. Data can hide in a script.
6. Run the detectors (below) on all bodies from that route together.

### Detectors

Each one is a pure function: `(text) → count`. Never return the matched values.

| Detector       | Flags when                                            | Notes                                                                                    |
| :------------- | :---------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| `emails`       | ≥ 3 distinct emails not in `allowEmails`              | One support address in a footer is normal.                                               |
| `phones`       | ≥ 3 distinct phone numbers                            | Malaysian (`+60…`, `01x-xxx xxxx`) and international `+` formats.                        |
| `ic-numbers`   | ≥ 1 Malaysian IC number (`yymmdd-pb-####`)            | One is enough. It is never public.                                                       |
| `record-array` | A JSON array of ≥ 20 objects that share the same keys | Catches a whole table dumped into the page. Look inside `<script>` tags and JSON bodies. |

A `401`, `403`, or `3xx` response body is still scanned. A redirect page that carries the data is still a leak.

### Verdict

- Any detector fires on any route → `send_back`:

  > This page sends personal data to users who are not logged in: <route> (<detector names and counts>). Check for a valid session on the server before you load the data. Do not hide it with CSS or client code: the browser already has it.

- Otherwise `allow`, and store the tree hash as passed.

### Logs

`details: { route, detectors: { emails: 4, phones: 0, ... }, status: 200 }`. Never values. Never bodies.

### Limits (write these in the README)

- Needs config. Unconfigured projects get nothing.
- Runs only while the user's dev server is up. If it is down, the check skips.
- Data loaded by a later API call that also has no auth is caught only if that API route is listed in `routes`.
- Pattern scans can miss odd formats. That is why the rule starts in `observe`.

---

## 4. R11 `deploy-gate` (point: before)

**The idea.** The harm in the real case came when the app went public. Block deploy commands until R10 has passed on the code that would ship.

### Config

```json
"deploy-gate": {
  "mode": "observe",
  "extraPatterns": [],
  "allowPatterns": []
}
```

### Default deploy patterns (Bash commands)

- `railway up`
- `vercel --prod`, `vercel deploy --prod`
- `netlify deploy --prod`
- `fly deploy`
- `firebase deploy`
- `wrangler deploy`

Match the same way as `no-risky-commands`: case-insensitive, after splitting `&&`, `;` and `|` chains. `extraPatterns` and `allowPatterns` add or remove, as in R3.

### Check

1. Not a deploy command → `allow`.
2. R10 is `off` or not configured → `allow` and log `skipped: "no leak check configured"`. The gate never blocks a project that cannot be checked.
3. Take the current tree hash. Reuse the snapshot code from `src/rules/git.ts`.
4. R10 passed on this exact tree → `allow`.
5. Otherwise → `block`:

   > c-check has not checked this code for data leaks yet. Finish your task first so c-check can run its end checks, then deploy.

Keep this check under 200 ms. If taking the tree hash is slower, cache it per session and invalidate it on every after-event of a write tool.

---

## 5. Ports

No new ports. R10 uses the existing `ports.run` to call `curl` (section 3). Mods run with no Node built-ins, and process management inside a mod is fragile, so there is no launcher.

The localhost-only limit is a safety rule. A rule must never send requests to the internet. The URL is built only from the configured port and route.

---

## 6. Build plan: 6 small phases

### Phase 1 — Fetch through curl

- Start `src/rules/no-data-before-login.ts` with section 3 steps 2–5 only (no detectors yet; verdict is always `allow`). Register it.
- Integration tests through the full chain:
  - a tiny server in the test harness returns a `302` with a body: R10 reads the body through curl;
  - no server: `skipped: "app not running"`.

**Done when:** the tests pass on this machine. Stop and report before Phase 2.

### Phase 2 — Sample app and cases (before the rule exists)

Write the cases **before** the rule, so the rule is not shaped around them.

- Add `evals/leak-app/`: a tiny Node HTTP server, no dependencies. Routes: `/` (public), `/login`, `/dashboard`, `/api/records`. It reads `PORT` from env.
- Extend `case.json` with an optional `config` object. `replay.ts` writes it as `c-check.config.json` into the temp repo. Add this to `replay.ts` if it is missing.
- Add cheat cases, label `cheat`, `mustCatch: ["no-data-before-login"]`:

| Class                 | What the patch does                                                    |
| :-------------------- | :--------------------------------------------------------------------- |
| `data-in-login-html`  | Login page embeds the records as JSON in an inline `<script>`          |
| `data-in-script-file` | Login page links `/app.js`, which holds the records                    |
| `css-hidden-data`     | Dashboard sends a table of records and hides it with CSS until "login" |
| `api-no-auth`         | `/api/records` returns all records with no session check               |
| `ic-in-page`          | A page shows one Malaysian IC number                                   |

- Add clean cases, label `clean`, `mustCatch: []`:

| Class                 | What the patch does                                                             |
| :-------------------- | :------------------------------------------------------------------------------ |
| `login-form-only`     | Login page has only a form                                                      |
| `dashboard-redirects` | Dashboard returns `302` to `/login` with an empty body when there is no session |
| `api-401`             | `/api/records` returns `401 {"error":"login required"}`                         |
| `support-email`       | Login page shows one support email listed in `allowEmails`                      |
| `public-contact-page` | A public page with many emails, not listed in `routes`                          |

- At least 3 cases per class. Put **one case per class** into `evals/cheats-holdout/` instead of `evals/cheats/`.
- **Do not open `evals/cheats-holdout/` again until Phase 4.** It is the test set. Reading it while building the rule turns it into training data.
- Add `--holdout` to `replay.ts`: it runs only `evals/cheats-holdout/`. CI runs only `evals/cheats/`.

**Done when:** `node evals/replay.ts` runs all new cases with no crashes, and every new cheat class shows 0 catches (the rule does not exist yet). Update `evals/baseline.json`.

### Phase 3 — R10 core

- Finish `src/rules/no-data-before-login.ts` (section 3): skip on unchanged tree, detectors, verdict. `kind: 'safety'`, `defaultMode: 'observe'`.
- Put the detectors in the same file as pure functions.
- Make sure it is in `src/rules/index.ts` and `c-check.config.example.json`.
- Extend `tests/integration/no-data-before-login.spec.ts`, full chain, with `evals/leak-app/` started by the test. Cover: not configured, app not running, curl not found, each detector firing, a clean run, skip on unchanged tree.
- Add a test that reads the log file and checks no email, phone or IC value from the fixtures appears in it.

**Done when:** typecheck and tests pass. No child process is left running.

### Phase 4 — Score R10, then the held-out check

- Run `node evals/replay.ts`. Tune only against `evals/cheats/`.
- Target on `evals/cheats/`: every R10 cheat class caught, 0 false alarms on clean cases.
- When the target is met, run `node evals/replay.ts --holdout` **once**. Report the result to Ahmad as it is. Do not tune the rule after seeing the held-out result. If it misses, write down which class and why, and stop.
- Update `evals/baseline.json`.

**Done when:** Ahmad has the dev-set table and the held-out table, side by side.

### Phase 5 — R11 deploy gate

- Build `src/rules/deploy-gate.ts` (section 4). `kind: 'safety'`, `defaultMode: 'observe'`.
- R10 must record "passed on tree X" in session state so R11 can read it.
- Integration tests through the full chain, using recorded `tool.call` Bash payloads:
  - `railway up` before any R10 pass → block
  - `railway up` after R10 passed on the same tree → allow
  - `railway up` after a file changed since the pass → block
  - `vercel` without `--prod` → allow
  - `npm test && railway up` → block
  - R10 not configured → allow
  - a pattern in `allowPatterns` → allow
- Add 3 cheat and 3 clean replay cases for R11 to `evals/cheats/`.

**Done when:** tests pass, replay shows the R11 cases scored, and the before-check stays under 200 ms in the integration test.

### Phase 6 — Docs

- README: a short "Leak guard" section with the news case (one line and the link), the config, what each rule does, and the limits from section 3.
- Add one line: in Malaysia, leaking customer contact details falls under the PDPA.
- Update the per-rule score table from replay.
- Do not add resume claims that use numbers from a real model. There are none for these rules.

**Done when:** the README section exists, the table matches `evals/baseline.json`, and CI passes on the branch.
