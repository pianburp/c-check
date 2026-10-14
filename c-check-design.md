# c-check — Design

> A verification mod for Claude Code. It checks what Claude does. It blocks, warns, or sends Claude back when a rule fails.

Status: Draft v0.1 (Oct 2026)
Owner: Ahmad
Target: Claude Code **mods** format only. Do not use the old plugin format.

---

## 0. Read this first (for Claude Code)

Before you write any code:

1. Read the current Claude Code docs for **mods**. Find out:
   - Which events a mod can listen to (before a tool runs, after a tool runs, when Claude tries to stop).
   - How a mod blocks an action and gives Claude a reason.
   - How a mod sends a message back to Claude.
   - How a mod is packaged, configured, and installed.
2. Do **not** use the old plugin format, `hooks.json`, or legacy hook setups. They are out of scope.
3. If the mods API cannot do something this design needs, stop. Write down what is missing. Ask Ahmad before you choose a workaround.
4. Keep all mod-specific code inside `src/adapter/`. Everything else must not depend on the mods API. This way, if the mods API changes, only one folder changes.

---

## 1. Problem

Claude Code can now run long tasks on its own. Nobody watches every step.

Today, most setups tell Claude how to behave in text (for example in `CLAUDE.md`). Over a long session, Claude often stops following those instructions. Text instructions are a hope, not a check.

When Claude makes a mistake, the user often finds out late. Examples:
- Claude says "done," but the tests fail.
- Claude edits a file outside the project.
- Claude runs a risky command.
- Claude writes a secret into a file.

## 2. Goal

c-check answers one question: **"Can I trust what Claude just did?"**

It turns rules into code. Code checks each action. The result is a clear verdict.

## 3. Non-goals

- Saving tokens. That is claude-saver's job.
- Teaching the user or asking the user to approve designs. That is a different kind of tool.
- Supporting old Claude Code versions or the old plugin format.
- Judging code quality or style. c-check checks hard rules, not taste.

---

## 4. Core ideas

1. **Rules are code.** If a program cannot check it, it is not a c-check rule.
2. **Check at three points:**
   - **Before** an action: stop bad actions before they happen.
   - **After** an action: inspect the result.
   - **At the end**: Claude cannot say "done" until the end checks pass.
3. **Every check gives one verdict:**
   - `allow` — continue.
   - `warn` — continue, but tell Claude and log it.
   - `block` — stop this action. Tell Claude why and what to do instead.
   - `send_back` — (end of task only) Claude is not done. Tell Claude what failed.
4. **Log everything.** Every check and verdict goes to a log file.
5. **Start soft, then harden.** A new rule starts in `observe` mode. It becomes `enforce` only when logs show it is safe.
6. **Verify enough, not more.** Too much checking is also a failure. It wastes effort, and it teaches Claude to satisfy checks and not the goal. So:
   - **Match the check to the damage.** Check hard where a mistake is costly or cannot be undone. Check lightly, or only at the end, where a mistake is cheap to fix.
   - **Prefer end checks over step checks.** One good end check costs less than many small ones.
   - **c-check never asks Claude to write tests or add code.** Rule messages say what failed and what to stop doing. They never say "add a test."
   - **Guard every gameable rule.** If Claude can pass a rule by cheating (for example, deleting a failing test), add a partner rule that catches the cheat.

---

## 5. Architecture

```
Claude Code
    │  (mod events)
    ▼
src/adapter/      ← only place that knows the mods API
    │  converts mod events into CheckEvent
    ▼
src/engine/       ← runs rules, combines verdicts, applies mode
    │
    ├── src/rules/    ← one file per rule
    ├── src/config/   ← loads c-check.config.json
    └── src/log/      ← writes JSONL logs
    │
    ▼
adapter turns the final Verdict back into a mod response
```

### 5.1 Language and tools

- TypeScript, Node.js.
- No runtime dependencies unless needed. Keep the mod small and fast.
- Tests with a standard runner (for example Vitest).

### 5.2 Speed budget

- Each check must finish in under 200 ms on a normal laptop.
- End-of-task checks that run tests may take longer. They must have a timeout (default 5 minutes).

---

## 6. Data shapes

These shapes do not depend on the mods API. The adapter converts to and from them.

```ts
type CheckPoint = "before" | "after" | "end";

interface CheckEvent {
  point: CheckPoint;
  sessionId: string;
  projectRoot: string;        // absolute path
  tool?: string;              // e.g. "Edit", "Write", "Bash", "Read"
  input?: Record<string, unknown>;   // tool input
  output?: unknown;           // tool result (after only)
  timestamp: string;          // ISO 8601
}

type VerdictKind = "allow" | "warn" | "block" | "send_back";

interface Verdict {
  kind: VerdictKind;
  ruleId: string;
  message?: string;   // shown to Claude. Say what failed AND what to do instead.
  details?: unknown;  // for the log only
}

type RuleMode = "off" | "observe" | "enforce";

interface Rule {
  id: string;                 // e.g. "no-outside-edits"
  description: string;
  points: CheckPoint[];       // where this rule runs
  defaultMode: RuleMode;
  check(event: CheckEvent, ctx: RuleContext): Promise<Verdict>;
}

interface RuleContext {
  config: RuleConfig;         // this rule's settings from c-check.config.json
  state: SessionState;        // per-session memory (e.g. files changed so far)
}
```

### 6.1 Combining verdicts

When several rules run on one event:

1. Any `block` wins. Return all block messages together.
2. Else any `send_back` wins (end point only).
3. Else any `warn`: allow, but pass the warnings to Claude.
4. Else `allow`.

### 6.2 Modes

- `off` — rule does not run.
- `observe` — rule runs and logs. Its verdict is turned into `allow`. Claude sees nothing.
- `enforce` — rule verdict is used as is.

---

## 7. Starter rules

Build these seven. Each one is small and catches real damage. R1 and R6 always ship together.

### R1 `tests-pass-before-done`  (point: end)

- **Check:** Run the project's test command. Pass if exit code is 0.
- **Test command:** from config. If not set, try to detect it (for example `npm test` if `package.json` has a `test` script). If none is found, return `warn` with "No test command found."
- **On fail:** `send_back`. Message includes the failing output (trimmed to the last 50 lines) and "Fix the failing tests, then finish."
- **Default mode:** `enforce`. This is the MVP rule.

### R2 `no-outside-edits`  (point: before)

- **Check:** For write/edit tools, the target path must be inside `projectRoot` after resolving `..` and symlinks.
- **On fail:** `block`. "This file is outside the project. Edit files inside <projectRoot> only."
- **Default mode:** `enforce`.

### R3 `no-risky-commands`  (point: before)

- **Check:** For shell commands, match against a deny list. Starter list:
  - `rm -rf` on `/`, `~`, or paths outside the project
  - `git push --force` / `git push -f`
  - `git reset --hard`
  - `DROP TABLE`, `DROP DATABASE`
  - `curl ... | sh`, `wget ... | sh`
- **On fail:** `block`. "This command can cause damage that is hard to undo. Ask the user first, or use a safer command."
- **Config:** users can add or remove patterns.
- **Default mode:** `observe` (pattern lists cause false blocks at first).

### R4 `no-secrets-in-files`  (point: after)

- **Check:** After a write/edit, scan the changed content for secret patterns (API key formats, private key headers, `password=` with a literal value, `.env`-style lines in non-env files).
- **On fail:** `warn` in v0.1. "This file may contain a secret at line N. Move it to an environment variable."
- **Default mode:** `observe`.

### R5 `claimed-changes-are-real`  (point: end)

- **Check:** Track which files changed during the session (from after-events). At the end, compare with `git status`/`git diff --name-only`. Flag files Claude edited that show no real change, and real changes Claude never reported touching.
- **On fail:** `warn`. List the mismatched files.
- **Default mode:** `observe`.

### R6 `no-test-weakening`  (point: end)

Partner rule for R1. R1 pushes Claude to make tests pass. This rule stops Claude from passing by cheating.

- **Check:** In the session's git diff, look for:
  - Deleted test files, or removed test cases.
  - New skip or focus markers (for example `.skip`, `.only`, `xit`, `it.todo`, `@pytest.mark.skip`).
  - Changes to the test command or test config that run fewer tests (for example a narrowed test path, a lowered coverage threshold).
- **On fail:** `send_back`. "Do not delete, skip, or narrow tests to make them pass. Fix the code. If the user asked you to remove these tests, say so in your final message and stop."
- **Default mode:** `enforce`. R1 is not safe without it.

### R7 `no-test-bloat`  (point: end)

Claude often adds unit tests nobody asked for, more so in long sessions. Code cannot fully judge "unnecessary." It can catch strong signs.

- **Check:** In the session's git diff, flag any of these:
  - New files in `tests/unit/` (or the project's unit test folder from config), when the user's request did not mention tests. Use the user's prompt if the mods API provides it. If not, skip this sign.
  - Test lines added are more than **2×** the source lines changed (ratio from config).
  - More than **5** new test cases in one session (number from config).
  - New tests that mock the very module they test.
- **On fail:** `warn`. "You added N tests the user did not ask for. Keep only tests for edge cases an integration test cannot cover. Remove the rest, or explain in one line why each one is needed."
- **Default mode:** `observe`. Thresholds will need tuning from logs before this rule can warn Claude.
- **Note:** This rule only warns. It never blocks. Wrong blocks here would cost more than extra tests.

---

## 8. Loop safety

`send_back` can trap Claude in a loop. Prevent this.

- Count send-backs per session per rule.
- After **3** send-backs from the same rule, stop sending back. Return `warn` with: "c-check could not get this check to pass after 3 tries. A human should look at it."
- Log this as a `gave_up` event.
- If the mods API gives a flag that says "this stop was already sent back," use it too.

---

## 9. Config

File: `c-check.config.json` at the project root. Optional. Defaults apply if missing.

```json
{
  "rules": {
    "tests-pass-before-done": { "mode": "enforce", "command": "npm test", "timeoutSec": 300 },
    "no-outside-edits":       { "mode": "enforce" },
    "no-risky-commands":      { "mode": "observe", "extraPatterns": [], "allowPatterns": [] },
    "no-secrets-in-files":    { "mode": "observe" },
    "claimed-changes-are-real": { "mode": "observe" },
    "no-test-weakening":      { "mode": "enforce" },
    "no-test-bloat":          { "mode": "observe", "unitTestDir": "tests/unit", "maxTestToSourceRatio": 2, "maxNewTestCases": 5 }
  },
  "maxSendBacks": 3,
  "logDir": ".c-check/logs"
}
```

Rules:
- Unknown keys: warn once, then ignore.
- Bad JSON: c-check must not crash Claude Code. Log the error, fall back to defaults, and warn Claude once.

---

## 10. Logging

- Format: JSON Lines, one line per check.
- Location: `.c-check/logs/<date>.jsonl` in the project.
- Each line:

```json
{"ts":"2026-10-11T10:00:00Z","session":"abc","point":"before","tool":"Bash","rule":"no-risky-commands","mode":"observe","verdict":"block","applied":"allow","ms":3}
```

- `verdict` = what the rule said. `applied` = what actually happened after mode.
- Never log full file contents or secret values. Log line numbers and rule IDs only.
- Add a small CLI command `c-check report` that reads logs and prints counts per rule: runs, warns, blocks, send-backs, gave-ups.

The report is how Ahmad decides when to move a rule from `observe` to `enforce`.

---

## 11. Failure safety

c-check must never be the reason Claude Code breaks.

- If a rule throws an error: log it, treat it as `allow`, and continue.
- If the engine fails: the adapter returns `allow`.
- If a check passes its time limit: treat as `warn` with "check timed out."

Exception: R1 test timeout returns `send_back` with the timeout noted, because "tests never finished" is not a pass.

---

## 12. Evals

Test the mod itself. Integration tests come first. Unit tests are rare.

### 12.1 Integration tests (most tests)

Almost every test goes through the full chain:
**raw mod event payload → adapter → engine → rules → mod response.**

- Folder: `tests/integration/`.
- Input: a real mod event payload, in the exact shape Claude Code sends. Record real payloads from a live session and save them as fixtures in `tests/integration/payloads/`. Do not hand-write the shape from memory.
- Environment: a real temporary git repo, created per test. Real files. Real `git` commands. A real test command (for example a tiny `package.json` whose `test` script passes or fails on purpose).
- Assert on the **mod response** that goes back to Claude Code, and on the **log line** written. Do not assert on internal function calls.
- Cover every rule with both bad cases (must block / warn / send back) and good cases (must allow).
- Target: every rule has at least 10 bad and 10 good cases, all run through the full chain.
- Keep them fast: the whole suite should run in under 60 seconds.

### 12.2 Unit tests (edge cases only)

Write a unit test only when an integration test cannot reach the case, or cannot reach it reliably. Allowed cases:

- A rule throws an error → engine still returns `allow` and logs the error.
- A check passes its time limit → correct timeout verdict.
- Loop safety: the 4th send-back from one rule becomes `warn` + `gave_up`.
- `c-check.config.json` is broken JSON → defaults load, one warning.
- Path edge cases that are hard to set up for real (for example symlink loops, Windows-style paths).
- The adapter gets an event shape it does not know → `allow`, logged.

If a unit test could be rewritten as an integration test, rewrite it.

### 12.3 Real task runs (small, slow, run before release)

- Folder: `evals/tasks/`. A small set of real tasks on a sample repo.
- Run each task with c-check on and off.
- Measure:
  - **Catches:** bad actions blocked or flagged.
  - **False blocks:** good actions blocked by mistake.
  - **Task success:** did the task still finish correctly.
  - **Extra time:** how much slower with c-check.

A rule may move to `enforce` by default only if its false-block rate in evals is under 2%.

---

## 13. Repo layout

```
c-check/
├── README.md
├── c-check.config.example.json
├── src/
│   ├── adapter/        # mods API only. Nothing else imports the mods API.
│   ├── engine/         # run rules, combine verdicts, apply modes, loop safety
│   ├── rules/          # one file per rule
│   ├── config/
│   ├── log/
│   └── cli/            # `c-check report`
├── evals/
│   └── tasks/          # real Claude Code task runs (slow, before release)
├── tests/
│   ├── integration/    # most tests: full chain, real temp git repos
│   │   └── payloads/   # recorded real mod event payloads
│   └── unit/           # edge cases only (see 12.2)
└── docs/
    └── writing-a-rule.md
```

---

## 14. Build plan

Build in this order. Each step must work and be tested before the next.

1. **M1 — Skeleton + R1 + R6.**
   Engine, config, log, adapter for the end point only, rules R1 and R6.
   Done when: in a real Claude Code session, Claude cannot finish while tests fail, cannot pass by deleting or skipping tests, and gives up after 3 tries.
2. **M2 — Before-point rules.**
   Adapter for the before point. R2 and R3.
   Done when: an edit outside the project is blocked with a clear message.
3. **M3 — After-point rules.**
   Adapter for the after point. Session state. R4, R5, and R7.
4. **M4 — Evals and report.**
   Full integration test coverage for all rules. `c-check report`. Task runs on a sample repo.
5. **M5 — Release.**
   README, install steps for the mods format, example config, `docs/writing-a-rule.md`.

---

## 15. Open questions

1. What exact events and response options does the mods API give? (Answer in step 0.)
2. Can a mod change a tool's input, or only allow/block it? If it can change input, should c-check ever fix commands itself? Default answer: no. c-check checks; it does not edit.
3. Should rules be shareable as packs (for example a "Next.js pack" or a "fintech pack")? Not in v0.1. Keep the rule interface clean so this is easy later.
4. Should c-check also check subagents? Decide after M3.