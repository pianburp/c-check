# c-check in Codex environments

Use standalone `c-check verify` in a local checkout, a Codex Cloud worktree, or CI. It runs `tests-pass-before-done` and `no-test-weakening` against the current Git worktree, including untracked files that Git does not ignore. It uses a private index and preserves the staging area. Tool-dependent and prompt-dependent rules need the live adapter.

## Standalone verification

Install Node 24 and Git. Install the target project's test dependencies. Run this command from a c-check checkout and point it at the project under review. If c-check itself is the project under review, use a separate c-check checkout for the verifier when validating untrusted changes.

```sh
node src/cli/c-check.ts verify --base <trusted-base-ref> --project <project-dir>
```

`--project` defaults to the current directory. Use the commit at the start of the task for local work. For a PR, fetch the target branch and use the merge base of the target and the proposed commit. Keep the verifier code and selected baseline under the CI job's control.

The baseline version of `c-check.config.json` supplies policy. The command uses the same test selection as the Claude rule, with the baseline's configured command preferred and `npm test` detected from the project when applicable. Enforced rules determine exit status, and observe-mode rules report findings without gating. An explicit baseline requirement for a live rule yields exit `2`. A fresh verification runs the tests even when the worktree matches the baseline. Run the verifier where you would run the proposed project's tests, with scoped credentials and permissions.

| Exit | Meaning |
| --- | --- |
| `0` | Enforced standalone checks completed and passed. |
| `1` | An enforced standalone check found a problem. |
| `2` | Verification was incomplete, for example because the baseline was invalid, no required test command was found, or tests timed out. |

## Develop in a Codex worktree

```sh
npm ci
npm run typecheck
npm run test:unit
```

For replay work, install Python and pytest. The existing CI workflow runs the replay comparisons. Use `npm run test:mod` only when the Claude CLI is installed. A hosted worktree can run the same setup and standalone verifier without a hook.

## Hook contract probe

The [probe](../tests/codex-probe.mjs) runs Codex CLI `0.169.0` in a disposable project against a scripted loopback model. It uses synthetic inputs and needs no account credentials. Pass the native `codex.exe` path on Windows, `codex` on Linux, or the npm package's `bin/codex.js` path on either platform. The probe creates an isolated Codex configuration, explicitly enables hooks, trusts only the disposable project, and uses the hook trust override only for its generated fixture. It keeps `workspace-write` enabled. The [manual probe workflow](../.github/workflows/codex-probe.yml) provides both Linux and Windows runners. [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks)

```sh
node tests/codex-probe.mjs codex pre-stop
node tests/codex-probe.mjs codex untrusted
node tests/codex-probe.mjs codex full
```

`pre-stop` checks pre-tool denial, failed patch verification, and one continuation. `untrusted` checks whether the hook is skipped and reports whether the client surfaced that skip. `full` additionally requires a successful multi-file edit and model-visible post-tool feedback.

| Client and profile | Observed result | Coverage still needed |
| --- | --- | --- |
| Codex CLI `0.169.0`, Windows, `exec --json`, `workspace-write`, unelevated Windows sandbox, fixture hook trust override | `SessionStart` reported `startup`. Startup, user prompt, pre-tool and stop hooks used the session cwd. A pre-tool denial reached the model and the sentinel was absent. Patch pre-input had a single `command` field. A failed patch verification reached the pre hook. `Stop` ran twice with the same turn ID, first inactive and then active. The continuation did not create a second `UserPromptSubmit`. | The allowed patch in the full probe failed to write in the outer workspace sandbox and stalled on an escalated rerun. Successful post-tool output, shell and background calls, interactive trust, resume, compact, fork, and subagent behavior need separate evidence. |
| Codex CLI `0.169.0`, Windows, `exec --json`, trusted disposable project with unreviewed hooks | Hook did not run. The JSON event stream contained no hook trust or review message. | Interactive `/hooks` review and persistence. |
| Linux CLI, Desktop, IDE, Codex Cloud | Standalone verification is the documented integration path. | Live hook discovery, trust, and event behavior remain unverified. |

The [sanitized capture](../tests/fixtures/codex/windows-0.169.0-exec.jsonl) records the Windows field names and event ordering. The [expansion plan](codex-expansion-plan.md) defines the remaining live hook gates.
