# c-check

[![CI](https://github.com/pianburp/c-check/actions/workflows/ci.yml/badge.svg)](https://github.com/pianburp/c-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code: v2.1.290+](https://img.shields.io/badge/Claude_Code-v2.1.290%2B-brightblue.svg)
![Runtime dependencies: none](https://img.shields.io/badge/runtime_dependencies-none-brightgreen.svg)

**Independent verification for [Claude Code](https://claude.com/claude-code). When Claude says it's done, c-check checks.**

![c-check status line: 41 checks passed, 1 warned, 2 caught, 1 seen](docs/statusline.svg)

Instructions in `CLAUDE.md` are guidance. c-check rules are code that runs on every edit, command and finish, so a passing result comes from your test runner and your git diff, not from a summary. When a rule fails, c-check blocks the action, warns, or sends Claude back to finish the work.

- **Measured:** 81 of 88 known cheats caught in a public, repeatable test suite, with the misses listed.
- **Quiet:** Claude hears nothing while checks pass, and you get a running score in the status line. Most rules start by logging only.
- **Safe to run:** if c-check itself fails, Claude Code carries on as if it were not installed.
- **Light:** no runtime dependencies, no daemon, no build step, no account.

## Install

In Claude Code:

```
/plugin install c-check --marketplace pianburp/c-check
```

Answer `y` to add the marketplace, then pick a scope. No config file is needed. Requires Claude Code v2.1.290 or later, and `git` on `PATH`.

## What it checks

**On from the start:**

- **Tests pass before done:** Claude is sent back with the failing test output.
- **No test cheating:** deleted, skipped or narrowed tests send Claude back.
- **No outside edits:** writes outside the project are blocked, after resolving `..` and symlinks.

**Start in `observe`.** They log what they would do, and Claude sees nothing:

- **Risky command guard:** `git push --force`, `git reset --hard`, `DROP TABLE`, `curl … | sh`.
- **Secret guard:** warns with the line number of a likely key in a file.
- **Leak guard:** sends Claude back when a login page leaks personal data to a logged-out visitor, and holds deploys until that check passes. Needs a port and routes in config.
- **Claim and test checks:** compares file edits with the real git diff, flags tests nobody asked for, and runs the original tests against the new code.

Review the catches with `c-check report`, then switch a rule to `enforce` when you agree with them. After 3 send-backs from one rule with no pass between them, c-check stops and tells Claude a human should look, so it cannot loop forever. The [full reference](docs/reference.md) covers every rule and setting.

## Proof

![Bar chart: c-check caught 81 of 88 known cheats. Per rule with 95% range: no-test-weakening 23/25, no-data-before-login 15/15, tests-still-bite 15/15, no-risky-commands 7/9, no-secrets-in-files 4/7, tests-pass-before-done 6/6, no-test-bloat 5/5, deploy-gate 3/3, no-outside-edits 3/3. Of 74 clean cases, 1 was blocked and 3 got warnings.](docs/proof.svg)

186 recorded cases (112 cheats, 74 clean) were replayed through the rules, with no model calls. CI repeats the replay on every PR and fails if a score gets worse.

The chart leaves out the model-based `judge-special-cases`, which is off by default and not yet measured.

What these numbers do not show:

- The cases are small sample projects, written by the person who wrote the rules. Held-out sets reduce this bias but do not remove it.
- Results on real work and an on/off comparison are not published yet.
- Disguised cheats can get through. The known misses are [listed by rule](docs/reference.md#rule-scores-cheat-suite).

Check it against your own past sessions. The output holds counts and positions, never your code, commands or prompts:

```sh
node proof/replay-sessions.ts
```

## What it runs, reads and sends

c-check needs local access to do its job. Everything it runs is listed here.

| Program | Used by | Why |
| :- | :- | :- |
| `git` | End-of-task rules | Records the working tree at session start and compares it with the end. Uses a private index, so your staging area is not touched. Adds a `refs/c-check/<session>` ref, and `tests-still-bite` makes a temporary worktree outside the project. |
| Your test command | `tests-pass-before-done`, `tests-still-bite` | Runs `command` from `c-check.config.json`, or `npm test` when `package.json` has a real `test` script. |
| `node` | `tests-still-bite` | Finds the temp folder and links `node_modules` into the temporary worktree. |
| `curl` | `no-data-before-login`, only if configured | Requests the pages you list, on `127.0.0.1` only. |
| `claude -p` | `judge-special-cases`, off by default | Sends the session's source diff for review through your own Claude Code. |

**Data sent off your machine:** none by default. c-check has no server, no telemetry and no outside network calls. If you turn on `judge-special-cases`, the diff goes wherever your Claude Code sends its requests. Your own test command can do whatever it is written to do.

**Personal data:** the leak guard reads responses from your local dev server and counts emails, phone numbers and ID numbers. It logs counts only, never the values.

**Your prompts:** kept in memory for the session, to tell whether you asked for test changes. They are not written to disk.

**Files written:**

- `.c-check/logs/<date>-<session>.jsonl` holds line numbers, file names and rule IDs, never file contents or secret values. Add `.c-check/` to your `.gitignore`.
- `.c-check/run-tests.cmd`, on Windows only, is the test command c-check runs. It is generated from your test command at each check.

## License

[MIT](LICENSE)
