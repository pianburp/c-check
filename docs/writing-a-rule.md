# Writing a rule

A rule is one file in `src/rules/` that exports a `Rule` (see `src/engine/types.ts`). Rules never import the mods API: everything they need from the outside world comes through `ctx.ports`.

## 1. Can a program check it?

If a program cannot decide pass or fail, it is not a c-check rule. Write it down as guidance somewhere else.

## 2. Pick the point

- `before`: stop an action before it happens. Use it only where the damage is costly or cannot be undone. It runs on every tool call, so keep it under 200 ms and avoid processes.
- `after`: inspect a tool's result. Same speed budget.
- `end`: runs when Claude tries to stop. Prefer this: one good end check costs less than many step checks. Use `sessionChanges(ctx)` from `src/rules/git.ts` for the session's diff; it is computed once per stop and shared.

## 3. Write it

```ts
import type { Rule } from '../engine/types'
import { sessionChanges } from './git'

const ID = 'no-todo-comments'

export const noTodoComments: Rule = {
  id: ID,
  description: 'Warns when the session adds TODO comments.',
  points: ['end'],
  kind: 'habit',
  defaultMode: 'observe',
  async check(event, ctx) {
    const changes = await sessionChanges(ctx)
    if (changes === null) return { kind: 'allow', ruleId: ID, details: { skipped: 'no git' } }
    const files = changes.files.filter(f => f.added.some(l => /\bTODO\b/.test(l))).map(f => f.path)
    if (files.length === 0) return { kind: 'allow', ruleId: ID }
    return {
      kind: 'warn',
      ruleId: ID,
      message: `New TODO comments in ${files.join(', ')}. Finish the work or tell the user what is left.`,
      details: { files },
    }
  },
}
```

Then add it to `RULES` in `src/rules/index.ts` and give it a default in `DEFAULTS.rules` in `src/config/config.ts`.

## 4. Rules for messages

- Say what failed **and** what to do instead.
- Never ask Claude to write tests or add code. Say what to stop doing.
- `details` goes to the log only. Put line numbers, file names, and counts there, never file contents or secret values.

## 5. Guard it if it can be gamed

If Claude can pass the rule by cheating (deleting the thing the rule looks at, editing the config, narrowing a command), add a partner rule that catches the cheat, as `no-test-weakening` does for `tests-pass-before-done`.

## 6. Start in observe

New rules start with `defaultMode: 'observe'`. Run them, read `c-check report`, and move to `enforce` only when the blocks are right. A rule may default to `enforce` only if its false-block rate in `evals/` is under 2%.

## 7. Test it through the full chain

Add `tests/integration/<rule-id>.spec.ts` with at least 10 bad and 10 good cases. Use `makeRepo` from `tests/integration/harness.ts`: it creates a real temp git repo, loads the real adapter, and fires recorded mod payloads. Assert on the mod response and the log line, not on internal calls. Write a unit test in `tests/unit/` only for a case the full chain cannot reach reliably.

## Failure behavior you get for free

- A rule that throws: logged, treated as `allow`.
- A rule whose process passes its `timeoutMs`: `warn` "check timed out", unless the rule catches `TimeoutError` itself (as `tests-pass-before-done` does, because tests that never finish are not a pass).
- `send_back` from a non-end point is treated as `block`.
- Loop safety: after `maxSendBacks` send-backs without a pass, the rule's send-back becomes a `warn` and a `gave_up` log line.
