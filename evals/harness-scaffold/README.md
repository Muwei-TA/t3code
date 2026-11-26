# Harness scaffold

Measures whether agents respect `T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS` when portable skills or on-demand/overflow rules are exposed over the `t3-harness` MCP server:

- Calling `harness_skill_search` / `harness_skill_load` when a user asks to apply a portable skill not natively installed.
- Calling `harness_rule_read` when a user asks to consult an on-demand or budget-overflow rule.
- Skipping `t3-harness` calls altogether on ordinary coding requests (control case).

```sh
cd evals
pnpm harness-scaffold --model gpt-6-luna --out runs/harness-before
pnpm harness-scaffold --model gpt-6-luna --out runs/harness-after --baseline runs/harness-before/results.json
```

The eval imports `T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS` directly from `@t3tools/provider-core/server/orchestrationInstructions`. CI runs `run.test.ts` against the deterministic grader without making paid model calls.
