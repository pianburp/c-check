# c-check for Codex expansion plan

**Planning baseline** · 2026-11-18 · c-check commit `856e630`

Ship an opt-in Codex CLI integration that uses the existing c-check rules to check supported tool calls and verify work before a turn finishes. Start with observe mode on Windows and Linux, then enable enforcement per rule after verifying the live hook behavior. Use the same engine for a standalone verification command so Codex Cloud and CI can verify a proposed change even when live hooks are unavailable.

The [Codex verification guide](codex.md) tracks the first implementation and the observed hook capabilities. Standalone verification is available. The live adapter remains gated on the hook probe.

This plan treats “Codex env” as both a runtime customers can install c-check into and an environment where contributors can develop c-check. The first supported runtime is the local CLI. Desktop, IDE, and hosted execution each have their own acceptance criteria.

## What the repository already provides

| Area | Current implementation and implication |
| --- | --- |
| Rule engine | [`src/engine`](../src/engine) owns rule execution, mode selection, verdict precedence, and per-rule send-back limits. Its `Ports` interface is the seam for another runtime. `CheckEvent` and the tool helpers still encode Claude tool names and single-file inputs. |
| Claude runtime | [`hooks/hooks.json`](../hooks/hooks.json) loads [`register.ts`](../src/adapter/register.ts). The mod owns session setup, in-memory state, tool interception, stop feedback, status, and toasts. Codex needs its own lifecycle adapter and launch path. |
| Verification | [`src/rules`](../src/rules) includes event checks and end checks backed by Git trees, test commands, and optional localhost probes. [`git.ts`](../src/rules/git.ts) uses a private Git index. The Claude adapter records a baseline and keeps it reachable through a ref for labeling. |
| Config and evidence | [`config.ts`](../src/config/config.ts) loads project defaults and overrides. [`log.ts`](../src/log/log.ts) queues rewrites of a session log held in memory. [`c-check.ts`](../src/cli/c-check.ts) reads JSONL, reports, and turns labeled findings into local eval cases. The log writer needs a process-safe path for Codex. |
| Tests and proof | [Integration tests](../tests/integration) exercise the Claude bridge with Node-backed ports and real Git. [CI](../.github/workflows/ci.yml) runs on Linux and Windows, including deterministic and held-out replays. [`proof/`](../proof) and the [billed task runner](../evals/run.ts) currently depend on Claude session formats or `claude -p`. |
| Distribution | [`package.json`](../package.json) is private, uses TypeScript entry points, and specifies Node 23.6+. The [Claude plugin](../.claude-plugin/plugin.json) runs TypeScript in the mod host. Pin Node 24 in the proposed Codex setup to match CI's Node major and ship a runnable artifact. |

The CLI available during planning identified itself as `codex-cli 0.169.0`, and its help lists `exec --json`. `npm.cmd run typecheck` passed. Live hooks, trusted installation, and managed or hosted surfaces still need the Phase 0 spike. Treat the observed CLI version as a test candidate and derive the supported minimum from the spike. [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) · [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

## Target surfaces

| Surface | Delivery | Condition for claiming support |
| --- | --- | --- |
| Local interactive CLI | Install one reviewed, opt-in project hook configuration. Support per-rule observation and enforcement. | Trusted hook discovery and real pre-tool denial and stop continuation on Windows and Linux. Test macOS before listing it. |
| `codex exec` and CI | Use the same hook runner where verified. Run an independent verification step over the resulting worktree for CI or when hooks are unavailable. | A pinned version demonstrates hook execution with the job's trust policy. The independent check works with hooks absent and has a documented exit contract. |
| Desktop local checkout and worktree | Supply tested setup instructions and later a manual plugin package if it improves installation. | Repeat the hook, worktree, and trust tests in desktop, including new worktrees and resumed threads. [Local environments](https://learn.chatgpt.com/docs/environments/local-environment) |
| IDE extension | Evaluate after the CLI integration is stable. | Verify discovery, trust UI, event coverage, and feedback with the extension before advertising enforcement. |
| Codex Cloud | Provide a reproducible environment setup and standalone verification commands. Use PR checks for a required gate. | A fresh task environment can install dependencies and produce the same check results as CI. Live hooks require separate proof in the specific hosted surface. [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments) |

## Phase 0 — Prove the Codex contract

1. Create a disposable repo and temporary Codex configuration with only a probe hook. Pin the CLI, record the platform and sandbox policy, review and trust the probe using the supported flow, and capture sanitized inputs. Compare interactive CLI with `codex exec`.
2. Record `SessionStart` for startup, resume, compact, fork, and clear as available. Record `UserPromptSubmit`, `Stop`, Bash pre/post including a background command completed through polling, and `apply_patch` pre/post including a multi-file patch and a failed patch. Verify field types, paths, correlation IDs, success detection, and the behavior of a synthetic continuation prompt. Verify whether and how subagent tool events can be attributed. Record differences on Windows PowerShell and Linux.
3. Prove side effects with harmless fixtures. Deny a patch that would create a sentinel and verify the file is absent. Return a post-tool warning and verify that the completed operation remains applied. Continue a turn once through `Stop`, then let it stop. Repeat with existing hooks, with untrusted hooks, and under the normal sandbox so skipped hooks and dropped responses are observable.
4. Probe hook command cwd, writable paths, environment inheritance, timeouts, feedback channels, and trusted script path handling. Keep Codex permissions in charge of sandbox and approval decisions. Use one hook command per event for c-check. Independent matching hooks may run concurrently. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

**Exit gate** · Commit sanitized fixtures and a capability table keyed by client, version, OS, and execution mode. Each supported blocking or continuation path needs an observed result. Ship independent verification on surfaces where the live contract cannot be demonstrated.

## Phase 1 — Build the hook adapter and durable state

Add the Codex implementation under `src/adapter/codex/`. Keep the current [Claude adapter](../src/adapter/register.ts) as its existing entry point. Put Codex wire parsing, reply serialization, and state storage at the edge. Share the existing rule runner, config parser, path checks, Git tools, and test runner. Add only the common types and helper changes needed to express Codex events. The proposed flow is `stdin → validate → normalize → load state → run rules → commit state/logs → reply`.

### Events and replies

| Codex hook | c-check behavior |
| --- | --- |
| `SessionStart` | Canonicalize the project root, capture the initial tree before editing, and retain its ref for labeling. Restore on resume and compaction. A fresh or forked ID gets an independent baseline. A missing baseline is recorded as a coverage gap so the current tree cannot silently stand in for the original session. |
| `UserPromptSubmit` | Derive the signals used by prompt-sensitive rules and deliver any queued warning once. Verify whether hook-generated continuations trigger this event, then exclude them from user-intent signals using verified correlation. |
| `PreToolUse` | Normalize supported shell and patch inputs, then run before checks. Map a blocking outcome to a Codex denial. Use additional context for enforce-mode warnings when the client supports it. On allow, return a neutral reply and preserve normal approval processing. |
| `PostToolUse` | Evaluate the completed edit and record successful changes. Warnings can add context. Any future post-tool block would affect result delivery after the action has already taken effect. |
| `Stop` | Run end checks. A send-back returns a block decision with a bounded, actionable reason, which Codex uses to continue. Deliver warnings as UI or event-stream messages, with next-prompt context if needed. Observe-mode findings stay in local logs. Use `stop_hook_active` as a continuation signal alongside persisted limits. |
| Other events | Defer subagent stop checks and optional end-of-session cleanup until the main-thread flow is proven. Required state writes happen during each event so an interrupted process or missing end event cannot erase the baseline. |

Use the event-specific JSON documented by OpenAI. In particular, use `hookSpecificOutput.permissionDecision: "deny"` for a supported pre-tool denial and the `Stop` block decision for a continuation. Keep stdout reserved for the expected reply. On invalid input or internal failure, emit the neutral response verified for that event and record a redacted diagnostic where possible. [Codex hook schemas and event behavior](https://learn.chatgpt.com/docs/hooks)

### Tool normalization

- In the shared event model, represent edits as a list of operations with a path, optional move destination, and added text. Preserve the existing Claude decoder through compatibility helpers. Evaluate the whole Codex patch in one pre-tool event so an invalid target denies the entire operation. Use one tool ID for correlation and cover both sides of moves.
- Decode the observed Codex patch grammar, including add, update, delete, and move, with fixtures for CRLF, spaces, Unicode, nested cwd, symlinks or junctions, and unsuccessful operations. Resolve paths from the real tool cwd and compare with the canonical worktree root. Keep these two directories explicit. Treat an unrecognized format as missing coverage and emit a redacted diagnostic.
- Use the observed result contract to identify which writes took effect. If it cannot distinguish partial success, reconcile affected paths with filesystem or Git evidence before counting them. Avoid treating a failed patch as a successful edit or assuming it had zero side effects.
- Use `tool_input.command` for the shell rules. Feed them the observed command text and tool cwd where available. Keep unsupported shell syntax, shell-mediated file writes, external mutations, and unclassified MCP tools explicit in the coverage table. Unified exec may deliver a late post event, and `write_stdin` does not run a new pre hook. [Codex tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage)

### State, logging, and process budget

- Store a versioned state record keyed by runtime, canonical worktree root, and full session ID or its hash. Persist the baseline, successful edit paths, retry counters, warn-once markers, and proven tree caches. Replace raw prompt history with only the signals needed by [`no-test-bloat`](../src/rules/no-test-bloat.ts) and [`tests-still-bite`](../src/rules/tests-still-bite.ts) in Codex. Rebuild per-event promises and memoization in memory.
- Serialize read–modify–write per session, or use an equivalent transactional store. Write state atomically, use a bounded lock, and test crash recovery and Windows file contention. Deduplicate tool events with the phase and tool ID. Distinguish real follow-up stops from repeated delivery when verifying the turn IDs. Keep retry limits across processes and add a bounded continuation limit across rules so alternating failures cannot loop. If state cannot be saved reliably, allow and mark the verification as incomplete.
- Use append-safe or serialized writes for JSONL so concurrent hook processes cannot replace each other's lines. Preserve fields consumed by `report`, `label`, and proof tooling. Add optional runtime, turn ID, and coverage fields with backward-compatible readers. Resolve one log directory for both baseline and verdict rows. Keep state, temporary scripts, and logs out of snapshots, including a custom in-tree log directory. Validate session IDs and rule IDs before deriving paths or Git refs.
- Build reusable Node `Ports` for the Codex hook and standalone verifier, using argv-based execution, bounded output and timeouts, explicit environment handling, and tested child cleanup. Budget the outer `Stop` hook for its invoked checks, including the two test runs in `tests-still-bite`. Keep short budgets for common tool events. Review execution privileges separately from the agent sandbox. Prefer an installed hook executable outside the agent-editable checkout and isolate test commands, Git helpers, and localhost probes appropriately. Verify Windows test-wrapper paths and concurrent use.
- Review existing log details and messages before reusing them in Codex. The current test rule logs the command, and generic errors can contain subprocess text. For Codex, use allowlisted log fields and bounded, redacted feedback. Never persist raw hook payloads, prompts, patch text, credentials, transcript contents, or subprocess output in evidence files. Keep Git snapshots and labeled case material local with a documented retention and cleanup policy.

**Exit gate** · A process-per-event integration test can start, edit, stop, continue, and report across fresh invocations. Parallel events, malformed input, missing Git, interrupted state writes, and exhausted send-backs each have observable outcomes. The Claude test harness and existing replay baselines pass.

## Phase 2 — Port rules in order of available evidence

Use an explicit Codex preview profile that caps supported rules at observe and sets the judge to off. Honor explicit `off` settings during the preview. Once a rule clears its release gate, allow an explicit Codex enforcement opt-in through the reviewed install configuration and continue using `c-check.config.json` for rule options. This keeps a shared project config from activating enforcement during a preview install. Preserve rule IDs and distinguish unavailable rules from passing rules.

| Rule | Codex plan and acceptance evidence |
| --- | --- |
| `tests-pass-before-done` | First end rule. Run the configured command in the correct worktree. Show failing tests cause a bounded continuation, passing tests permit completion, and unchanged green trees skip reruns. A missing baseline must not produce a false skip. |
| `no-test-weakening` | Ship alongside the test gate. Confirm baseline-to-current diffs capture deleted and skipped tests, narrowed commands, and edits to c-check config. Preserve legitimate test additions and fixes in the existing replay. |
| `no-outside-edits` | Check every supported patch target, including delete, move source and destination, and junction or symlink resolution. Show that a denied multi-file patch applies no operations. Report coverage as structured patch edits. |
| `no-risky-commands` | Reuse shell rules over observed Bash hook input. Verify representative harmless denials and allow patterns for each supported OS and shell. Document unsupported command forms. |
| `no-secrets-in-files` | Scan new text for every successful patch operation. Use synthetic tokens to test findings, line attribution, permitted files, and redaction. Keep this advisory after the write. |
| `claimed-changes-are-real` | Compare observed edit paths and Git changes. Keep observe-only until clean renames, reverts, and shell-generated changes establish a usable false-alarm rate. |
| `no-test-bloat` | Prove that a genuine request for tests affects the same decision as in Claude and that a synthetic continuation cannot override user intent. |
| `tests-still-bite` | Verify the fresh `tests-pass-before-done` result is visible to the rule during the same stop and the original tests run in an isolated temporary worktree. Check missing dependencies, timeout, and cleanup on Windows and Linux. |
| `no-data-before-login` | Keep opt-in via configured routes and a loopback service. Validate against synthetic fixtures for reachable, stopped, and partially checked servers. Record a clean tree only after all required routes are checked. |
| `deploy-gate` | Keep in observe until live Bash and cache invalidation are proven. Recompute the current Git tree before a recognized deploy on Codex, or prove equivalent invalidation including background tools and edits outside the session. Tie the clean-tree record to the relevant leak-check configuration. Use a stub deployment executable in tests. |
| `judge-special-cases` | Exclude from the first Codex release. The existing implementation calls `claude -p`. A later opt-in provider decision needs independent calibration, a recursion guard, explicit authorization for sending diffs, and cost reporting. |

## Phase 3 — Install, develop, and verify in Codex environments

1. **Package the hook runner.** Produce a versioned Node ESM artifact with explicit runtime requirements. Current shared sources use extensionless imports and some dev scripts use custom resolution, so test the standalone artifact from a fresh target repo with no source checkout or dev dependencies. Put the Codex hook config in an isolated distribution path. The existing root `hooks/hooks.json` belongs to the Claude mod and has a different schema.
2. **Ship one opt-in install path.** Start with a documented install into an existing trusted project's `.codex/hooks.json`, or the supported config equivalent established in the spike. Reference the installed artifact using correctly quoted POSIX and Windows commands. Show setup from a directory containing spaces and when Codex starts in a subdirectory. Preserve existing hooks on install and remove only c-check entries on disable or uninstall. Verify the configured entry via `/hooks` and a local `c-check doctor` command. Doctor should distinguish configured, trusted or executed, and missing evidence using the information available to it. [Hook configuration and trust](https://learn.chatgpt.com/docs/hooks)
3. **Support c-check contributors.** Add a small root `AGENTS.md` with repo-specific verification commands and the held-out eval convention from [the reference](reference.md#rule-scores-cheat-suite). Document the difference between contributor guidance and enforced restrictions. Keep held-out cases outside ordinary rule-development context, with protected access in the scoring job where blinding is required. Publish a local worktree and Cloud setup recipe with Node 24, Git, `npm ci`, and Python/pytest for replay cases. Use `npm run typecheck` and `npm run test:unit` for the portable checks. `npm test` currently also requires the Claude CLI.
4. **Add standalone verification.** Introduce a proposed `c-check verify --base <ref> [--project <path>]` command that takes an explicit baseline and evaluates eligible end rules against the current workspace, including dirty changes. Use the same engine and test selection. Validate the ref and merge-base strategy in CI. Give it an explicit exit contract, for example `0` when required checks completed successfully, `1` for a finding in an enforced rule, and `2` for incomplete verification. Missing required tests, timeouts that prevent verification, state failures, and unsupported required checks must never look green. Report tool- and prompt-dependent rules as unavailable. Use this command in an independent PR job with trusted rule config and code and scoped credentials. Keep live hook failures fail-open as in the current design.
5. **Evaluate manual desktop packaging.** After the CLI install passes, package desktop resources under a dedicated plugin root with a portable manifest and hook files. Test fresh install, trust review, update, worktree setup, disable, and uninstall. Use the documented manual distribution channel for hook-bearing plugins. [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)

## Phase 4 — Prove behavior, roll out, and maintain it

| Gate | Evidence required |
| --- | --- |
| Repository regression | Current `npm run typecheck`, `npm run test:unit`, Claude mod validation and test on a suitable runner, and both existing replay comparisons pass. Keep the existing baselines as Claude-compatible regression gates. |
| Offline Codex contract | Sanitized fixtures drive the packaged hook through subprocess stdin/stdout. Assert deny and stop replies, quiet observe mode, correct state and log counts, no staging-area changes, redaction, duplicate event handling, and fail-open behavior. Cover non-Git roots, dirty worktrees, resume/compact/fork, and two sessions or worktrees running in parallel. Run on Windows and Linux in CI without credentials. |
| Live canary | On pinned releases, verify trusted startup, a denied write with no side effect, a permitted write, a failing test that continues, a fixed test that completes, and permanent failures that stop at the documented cap. Check that disabling hooks restores ordinary Codex behavior and that `verify` still works. Treat untrusted, skipped, or unsupported hooks as missing coverage in the report. |
| Field evidence | Extend `c-check report` and [live proof](../proof/live-report.ts) to filter by runtime and assess checks, findings, failures, coverage gaps, label counts, and latency. Record Codex and Node versions, OS, and sandbox profile. Pilot in observe mode on c-check and other projects. Review false alarms and report sample size and uncertainty before promoting rules. Keep runtime-specific results identifiable across upgrades. |
| Billed A/B | Add a Codex transport to the existing task runner once deterministic coverage passes. Use `codex exec --json`, fresh fixture repos, the same model and permission profile for both arms, and externally score results. Parse usage and failures from JSONL, apply bounded timeouts and a run budget, and report missing cost as unknown. Keep the workflow manually dispatched with scoped credentials and redacted artifacts. [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) |
| Release | Document verified OS/client/version combinations, install and removal, configuration examples, rule-level coverage, and troubleshooting. Require zero incorrect blocks or missed expected blocks in the deterministic release cases. Set a measured latency target in the spike and agree on field false-alarm thresholds before enforcing by default. |

Defer historical Codex transcript replay until it adds evidence beyond hook logs and the A/B runner. Treat transcript decoding as versioned, optional, and best-effort. The documented `transcript_path` can be null, and the file format can change. Keep historical replay out of the enforcement path. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

### Rollout and rollback

1. Land the capability probe and fixtures, then the adapter and deterministic CI. Publish an observe-only preview from a pinned artifact.
2. Promote the test-pass and test-weakening pair first after the stop canary and pilot pass. Promote outside-edit enforcement after structured patch coverage passes. Keep other rules in their preview modes until their own evidence meets the release gate.
3. For a bad rollout, switch the affected rule to `observe` or `off`, or disable the c-check hook entries. Keep logs for diagnosis and use standalone verification during the rollback. Roll back to the previous artifact if the state and hook schema are compatible. Preserve old state for reporting and quarantine incompatible state before the next startup.
4. Recheck the hook contract before bumping the supported Codex version. Keep the offline fixture matrix and the pinned live canary as independent checks.

The first release is complete when a user can install c-check in a clean Codex CLI project, see what its hooks cover, verify a blocked patch and an end-check continuation, review the findings locally, and remove the integration. The same release should let a Windows or Linux contributor run portable checks and let a CI or Cloud worktree verify a change without a live hook.
