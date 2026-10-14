# c-check

A verification mod for Claude Code. It checks what Claude does. It blocks, warns, or sends Claude back when a rule fails.

c-check answers one question: **"Can I trust what Claude just did?"** Rules are code, not text in `CLAUDE.md`. See [c-check-design.md](c-check-design.md) for the full design.

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

`tests-pass-before-done` and `no-test-weakening` always ship together: the first pushes Claude to make tests pass, the second stops it from passing by cheating.

Verdicts: `allow`, `warn` (continue, tell Claude, log), `block` (stop the action, tell Claude why), `send_back` (end only: Claude is not done). Modes: `off`, `observe` (log only, Claude sees nothing), `enforce`.

After 3 send-backs from the same rule without a pass in between, c-check stops sending back, tells Claude a human should look, and logs `gave_up`.

## Requirements

- Claude Code v2.1.290 or later (mods).
- Node.js 23.6 or later, only for `c-check report`, the tests, and the evals.
- `git` on `PATH`. The end rules compare the working tree with its state at session start. Without git they allow and log `no git`.

## Install

c-check is a mod: a plugin whose `hooks/hooks.json` points at `src/adapter/register.ts`. Claude Code runs the TypeScript directly; there is no build step.

Try it for one session:

```sh
claude --plugin-dir /path/to/c-check
```

To load it in every session, list it in `CLAUDE_CODE_PLUGIN_DIRS` (absolute paths, `;` between them on Windows, `:` elsewhere), or add the folder to a plugin marketplace and install it with `claude plugin install c-check@<marketplace> --scope project`.

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
