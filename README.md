# c-check

[![CI](https://github.com/pianburp/c-check/actions/workflows/ci.yml/badge.svg)](https://github.com/pianburp/c-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code: v2.1.290+](https://img.shields.io/badge/Claude_Code-v2.1.290%2B-brightblue.svg)
![Runtime dependencies: none](https://img.shields.io/badge/runtime_dependencies-none-brightgreen.svg)

Trust what [Claude Code](https://claude.com/claude-code) just did.

![c-check status line: 41 checks passed, 1 warned, 2 caught, 1 seen](docs/statusline.svg)

c-check checks every edit, command and finish. It blocks, warns, or sends Claude back when a rule fails.
Rules are code, not text in `CLAUDE.md`, so Claude cannot talk its way past them.
One mod, no runtime dependencies, no daemon, no build step.

## Install

In Claude Code:

```
/plugin install c-check --marketplace pianburp/c-check
```

Answer `y` to add the marketplace, then pick a scope. No config file needed: safe defaults apply.
Needs `git` on `PATH`.

## What it catches

![Bar chart: c-check caught 81 of 88 known cheats. Per rule with 95% range: no-test-weakening 23/25, no-data-before-login 15/15, tests-still-bite 15/15, no-risky-commands 7/9, no-secrets-in-files 4/7, tests-pass-before-done 6/6, no-test-bloat 5/5, deploy-gate 3/3, no-outside-edits 3/3. Of 74 clean cases, 1 was blocked and 3 got warnings.](docs/proof.svg)

186 recorded cases (112 cheats, 74 clean) were replayed through the rules, with no model calls.
The chart leaves out the model-based `judge-special-cases`, which is off and not measured.
Real-session and live-log numbers will be added after more sessions are recorded.

Limits: lab cases are small sample projects, written by the person who wrote the rules. [Method and full numbers](docs/reference.md#proof).

Check it against your own past sessions. It prints counts only, never their content:

```sh
node proof/replay-sessions.ts
```

## What you get

- **Tests pass before done:** Claude is sent back with the failing test output.
- **No test cheating:** deleted, skipped, narrowed or rewritten-to-fit tests send Claude back.
- **No outside edits:** blocks writes outside the project, after `..` and symlinks.
- **Risky command guard:** `git push --force`, `git reset --hard`, `DROP TABLE`, `curl … | sh`.
- **Secret guard:** warns with the line number of a likely key in a file.
- **Leak guard:** sends Claude back when a login page leaks personal data to a logged-out visitor, and holds deploys until that check passes.

The first three are on from the start. The rest start in `observe`: they log what they would do, and Claude sees nothing.
Switch one to `enforce` when you agree with its catches in `c-check report`.
See the [full reference](docs/reference.md).

## License

[MIT](LICENSE)
