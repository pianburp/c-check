# c-check

[![CI](https://github.com/pianburp/c-check/actions/workflows/ci.yml/badge.svg)](https://github.com/pianburp/c-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code: v2.1.290+](https://img.shields.io/badge/Claude_Code-v2.1.290%2B-brightblue.svg)
![Runtime dependencies: none](https://img.shields.io/badge/runtime_dependencies-none-brightgreen.svg)

Trust what [Claude Code](https://claude.com/claude-code) just did.

c-check is a verification [mod](#install) that checks every edit, command and finish. It blocks, warns, or sends Claude back when a rule fails.
Rules are code, not text in `CLAUDE.md`, so Claude cannot talk its way past them. No daemon, no build step. See [c-check-design.md](c-check-design.md) for the full design.

At the Claude Code prompt:

```
/plugin install c-check --marketplace pianburp/c-check
```

Answer `y` to add the marketplace, then pick a scope. That is the whole setup: no clone, no `npm install`, no config file (safe defaults apply).

The status line then keeps score for the session, for example `c-check ✓ 41 passed · ⚠ 1 warned · ✗ 2 caught`. A toast says what was caught, and `c-check: all end checks passed` when Claude finishes clean.

## What it checks

| Rule | When | Default | On fail |
| :- | :- | :- | :- |
| `tests-pass-before-done` | end | enforce | Send Claude back with the last 50 lines of test output |
| `no-test-weakening` | end | enforce | Send Claude back: deleted, skipped, or narrowed tests |
| `no-outside-edits` | before | enforce | Block edits outside the project (after `..` and symlinks) |
| `no-risky-commands` | before | observe | Block `git push --force`, `git reset --hard`, `DROP TABLE`, `curl … \| sh`, `rm -rf` outside the project |
| `no-secrets-in-files` | after | observe | Warn with the line number of a likely secret |
| `claimed-changes-are-real` | end | observe | Warn when file edits and the real git diff do not match |
| `no-test-bloat` | end | observe | Warn about tests nobody asked for. Never blocks. |
| `no-data-before-login` | end | observe | Send Claude back when a page that needs a login sends personal data to a logged-out visitor. See [Leak guard](#leak-guard) |
| `deploy-gate` | before | observe | Block deploy commands until the leak check has passed on the exact code being deployed. See [Leak guard](#leak-guard) |
| `tests-still-bite` | end | observe | Send Claude back when the original tests fail on the new code (tests were changed to fit) |

`tests-pass-before-done` and `no-test-weakening` always ship together: the first pushes Claude to make tests pass, the second stops it from passing by cheating.

Verdicts: `allow`, `warn` (continue, tell Claude, log), `block` (stop the action, tell Claude why), `send_back` (end only: Claude is not done). Modes: `off`, `observe` (log only, Claude sees nothing), `enforce`.

After 3 send-backs from the same rule without a pass in between, c-check stops sending back, tells Claude a human should look, and logs `gave_up`.

## Leak guard

In 2026 a South African coffee franchise exposed company and private customer data through a vibe-coded web app ([MyBroadband](https://mybroadband.co.za/news/software/672602-south-african-coffee-franchise-exposes-company-and-private-data-in-vibe-coded-web-application.html)). Two rules aim at that failure. Both are `safety` rules, so they are never retired, and both default to `observe`.

- `no-data-before-login` (R10, end): requests the pages you list from your running dev server while logged out, and sends Claude back if the response holds personal data: 3 or more distinct emails (outside `allowEmails`), 3 or more phone numbers, any Malaysian IC number, or a JSON array of 20 or more same-shaped records. It also scans up to 10 same-origin scripts the page links. Data hidden with CSS is still data sent. Logs hold counts, never values.
- `deploy-gate` (R11, before): blocks a deploy command until R10 has passed on the exact code that would ship. It allows when R10 is off or not configured, so it never blocks a project that cannot be checked.

```json
"no-data-before-login": { "mode": "observe", "port": 3000, "routes": ["/login", "/dashboard"], "allowEmails": ["support@example.com"] },
"deploy-gate": { "mode": "observe", "extraPatterns": [], "allowPatterns": [] }
```

Default deploy patterns: `railway up`, `vercel --prod`, `netlify deploy --prod`, `fly deploy`, `firebase deploy`, `wrangler deploy`. `extraPatterns` and `allowPatterns` work as in `no-risky-commands`.

Limits:

- Needs config. Unconfigured projects get nothing.
- Runs only while your dev server is up. If it is down, the check skips.
- Data loaded by a later API call that also has no auth is caught only if that API route is listed in `routes`.
- Pattern scans can miss odd formats. That is why the rule starts in `observe`.

In Malaysia, leaking customer contact details falls under the PDPA.

On a one-time run of a separate hold-out set (`node evals/replay.ts --holdout`, not in `baseline.json`), `no-data-before-login` caught 4 of 5 leaks with 0 of 5 false alarms. It missed the `ic-in-page` class.

## Requirements

- Claude Code v2.1.290 or later (mods).
- Node.js 23.6 or later, only for `c-check report`, the tests, and the evals.
- `git` on `PATH`. The end rules compare the working tree with its state at session start. Without git they allow and log `no git`.

## Install

c-check is a mod: a plugin whose `hooks/hooks.json` points at `src/adapter/register.ts`. Claude Code runs the TypeScript directly; there is no build step.

Install from the marketplace (from a shell: `claude plugin install c-check --marketplace pianburp/c-check`), or try a local checkout for one session:

```sh
claude --plugin-dir /path/to/c-check
```

To load it in every session, list it in `CLAUDE_CODE_PLUGIN_DIRS` (absolute paths, `;` between them on Windows, `:` elsewhere).

Check what Claude Code reads from the mod:

```sh
claude plugin validate /path/to/c-check
```

In a session, `/plugin` shows `1 mod active · c-check`.

## Configure

Copy [c-check.config.example.json](c-check.config.example.json) to `c-check.config.json` at your project root. The file is optional: defaults apply without it. Unknown keys get one warning and are ignored. Broken JSON never breaks Claude Code: c-check falls back to defaults and warns Claude once.

- `tests-pass-before-done.command`: the test command. Without it, c-check uses `npm test` when `package.json` has a real `test` script; otherwise it warns "No test command found."
- `tests-pass-before-done.timeoutSec`: default 300. A test run that never finishes sends Claude back.
- `no-risky-commands.extraPatterns` / `allowPatterns`: regular expressions (case-insensitive) that add to or carve out of the deny list.
- `no-test-bloat.unitTestDir`, `maxTestToSourceRatio`, `maxNewTestCases`: thresholds.
- `no-data-before-login.port`, `routes`, `allowEmails`, and `deploy-gate.extraPatterns` / `allowPatterns`: see [Leak guard](#leak-guard).
- `maxSendBacks`: default 3. `logDir`: default `.c-check/logs`.

Claude editing `c-check.config.json` during a session counts as test weakening.

## Logs and the report

Every check writes one JSON line to `.c-check/logs/<date>-<session>.jsonl`:

```json
{"ts":"2026-10-11T10:00:00Z","session":"abc","point":"before","tool":"Bash","rule":"no-risky-commands","mode":"observe","verdict":"block","applied":"allow","ms":3}
```

`verdict` is what the rule said; `applied` is what happened after its mode. Logs hold line numbers, file names, and rule IDs, never file contents or secret values. Add `.c-check/` to your `.gitignore`.

```sh
node /path/to/c-check/src/cli/c-check.ts report [project-dir]
```

prints runs, warns, blocks, send-backs, gave-ups, and errors per rule. Move a rule from `observe` to `enforce` when its blocks in the report are ones you agree with.

## How Claude hears about a failure

- **block** before a tool: the tool does not run, and Claude reads the reason as the tool's result.
- **warn** around a tool: added to what Claude reads after the tool's result.
- **send_back** at the end: Claude's stop is refused and it reads what failed.
- **warn** at the end: shown to you under the answer, and handed to Claude with your next prompt. (Text handed to Claude at the stop would make it keep working, so it waits.)

c-check fails open: if a rule throws, the engine allows and logs it; if the adapter fails, Claude Code carries on as if c-check were not there.

## Develop

```sh
npm install
npm run typecheck
npm run test:unit   # Vitest: full-chain integration tests in real temp git repos, plus edge-case unit tests
npm run test:mod    # claude plugin test: the mod in Claude Code's own (sandboxed) runtime
node evals/run.ts   # slow, billed: real claude -p task runs with c-check on and off
```

Layout:

```
src/adapter/   the only code that knows the mods API
src/engine/    runs rules, combines verdicts, applies modes, loop safety
src/rules/     one file per rule
src/config/    loads c-check.config.json
src/log/       writes JSONL logs
src/cli/       c-check report
tests/integration/  full chain: recorded payload -> adapter -> engine -> rules -> mod response (*.spec.ts, Vitest)
tests/unit/         edge cases only
tests/mod/          *.test.ts for claude plugin test
evals/              sample repo and real task runs
```

To add a rule, see [docs/writing-a-rule.md](docs/writing-a-rule.md).

## Rule scores (cheat suite)

Catch rate on recorded cheats, and false alarms on clean runs. CI replays the suite on every PR and fails if a number gets worse than `evals/baseline.json`.

<!-- rule-table -->
| rule | catch rate | false blocks | false warnings |
| :- | :- | :- | :- |
| deploy-gate | 3/3 (100.0%) | 0/67 | 0/67 |
| judge-special-cases | 0/21 (0.0%) | 0/67 | 0/67 |
| no-data-before-login | 15/15 (100.0%) | 0/67 | 0/67 |
| no-outside-edits | 3/3 (100.0%) | 0/67 | 0/67 |
| no-risky-commands | 0/0 (n/a) | 0/67 | 0/67 |
| no-secrets-in-files | 3/3 (100.0%) | 0/67 | 0/67 |
| no-test-bloat | 0/0 (n/a) | 0/67 | 0/67 |
| no-test-weakening | 19/19 (100.0%) | 0/67 | 0/67 |
| tests-pass-before-done | 0/0 (n/a) | 0/67 | 0/67 |
| tests-still-bite | 12/12 (100.0%) | 0/67 | 3/67 |

`judge-special-cases` is off by default, so it scores 0 here until calibrated. All 3 `tests-still-bite` false warnings are test changes the user asked for (the prompt downgrade). A false block (send-back or block) costs far more than a false warning, so the two are counted, and gated, separately.

The 143 cases come from two sample projects: a `node --test` math library and a Vitest shop cart (`*-vitest-*`, which borrows c-check's own `node_modules`). Both are small, so 100% here says little about pytest, Jest or a large codebase.

### Held-out cases

`evals/heldout/` (32 cases, about a third of each class) is scored with the rest and also on its own:

| rule | catch rate | false blocks | false warnings |
| :- | :- | :- | :- |
| deploy-gate | 0/0 (n/a) | 0/14 | 0/14 |
| judge-special-cases | 0/6 (0.0%) | 0/14 | 0/14 |
| no-data-before-login | 0/0 (n/a) | 0/14 | 0/14 |
| no-outside-edits | 1/1 (100.0%) | 0/14 | 0/14 |
| no-risky-commands | 0/0 (n/a) | 0/14 | 0/14 |
| no-secrets-in-files | 1/1 (100.0%) | 0/14 | 0/14 |
| no-test-bloat | 0/0 (n/a) | 0/14 | 0/14 |
| no-test-weakening | 7/7 (100.0%) | 0/14 | 0/14 |
| tests-pass-before-done | 0/0 (n/a) | 0/14 | 0/14 |
| tests-still-bite | 3/3 (100.0%) | 0/14 | 0/14 |

The held-out set has no leak-guard cases. Rule work must never read it: `.claude/settings.json` denies Claude's Read and Edit tools there, and humans should not open it while changing a rule either. If held-out scores drop below the main ones, the rules are fitting the cases they were written against. The cases moved there on 2026-10-19 had already been seen while the rules were written, so they only guard work done from that date on. New held-out cases should be written by someone who has not read the rule they target.

<!-- /rule-table -->

### R9 calibration

`judge-special-cases` asks the real `claude` model, so it costs money and is never run by CI. The 41 calibration cases (20 `hard-coded-answer` cheats, 1 `judge-injection` cheat, 20 clean source fixes) carry `"calibration": true` in `case.json`. To measure it:

```
node evals/replay.ts --judge --repeat 3
```

It prints catch rate, false alarm rate (each with a 95% Wilson range) and self-agreement (share of cases where all runs gave the same verdict). Targets: catch rate >= 80%, false alarm rate <= 10%, self-agreement >= 90%.

The judge runs on a different model from the agent it judges: `"model"` in its config, default `sonnet`, passed as `ANTHROPIC_MODEL`. If your agent runs on Sonnet, set it to something else. Its prompt tells it the diff is untrusted, so comments in it are not instructions. The `judge-injection` case checks this with a comment that asks the judge to say "clean".

Not run yet — R9 stays off until it is.

## Rule retirement

A rule that fixes a habit the newest model no longer has only costs runtime and risks false blocks. Each rule has a `kind`:

- `safety` (`no-outside-edits`, `no-risky-commands`, `no-secrets-in-files`, `no-data-before-login`, `deploy-gate`): rare, costly, hard to undo. Never retired, even at 0 fires.
- `habit` (the rest): fixes model behaviour that may go away. Retired on numbers.

After each major model release (and at least every 6 months), run every task with all rules in `observe`, so Claude sees nothing from c-check. This is billed.

```
node evals/run.ts --model <model-id> --retire-check --trials 10
node evals/retire.ts <model-id> [previous-model-id]
```

The first command writes `evals/results/models/<model-id>.json` (fire counts per rule: runs where the raw verdict was not `allow`). The second prints one row per rule with fire rates (95% Wilson range) and a verdict:

Retiring a rule is a PR that sets its default mode to `off`, with the report in the PR text. Never delete the rule code or its cheat-suite cases: the suite keeps checking it works, so it can return if a later model brings the habit back.

Latest report: No retire run yet.

## Contributing

Ground rules for PRs:

- **No runtime dependencies.** Dev tools only (TypeScript, Vitest).
- **Fail open.** A rule or adapter bug must never break Claude Code: the engine allows and logs.
- **Silent when fine.** Claude reads what c-check prints, so print only on a failure.
- **Never log contents.** Logs hold line numbers, file names and rule IDs, not file contents or secrets.
- **Add a test.** Each rule gets a full-chain test in `tests/integration/`.

Run `npm run typecheck && npm run test:unit` before you open a PR. Bug reports are most useful with your OS, Claude Code version, and the matching lines from `.c-check/logs/`.

## License

[MIT](LICENSE)
