# Working on c-check

Use Node 24, Git, and `npm ci`. Install Python with pytest for the replay cases that exercise Python projects.

- Run `npm run typecheck` and `npm run test:unit` for portable checks. Use `npm run validate` and `npm run test:mod` when the Claude CLI is available.
- Keep shared rules in `src/rules`. The Claude adapter uses the mods API, and standalone verification uses Node ports.
- Keep `evals/heldout/` and `evals/cheats-holdout/` outside rule-development context. Run scoring without reading individual held-out cases when evaluating a change. Follow the [held-out scoring convention](docs/reference.md#rule-scores-cheat-suite).
- Use the [Codex verification guide](docs/codex.md) for standalone verification and the hook capability probe.
