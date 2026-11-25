import * as NodeUtil from "node:util";
import { T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { HARNESS_SCAFFOLD_CASES } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    case: { type: "string" },
    baseline: { type: "string" },
  },
});

if (!values.out) {
  process.stderr.write("Missing required --out <dir> flag.\n");
  process.exit(1);
}

const selectedCases = values.case
  ? values.case
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => {
        const found = HARNESS_SCAFFOLD_CASES.find((c) => c.id === id);
        if (!found) {
          process.stderr.write(`Unknown --case: ${id}\n`);
          process.exit(1);
        }
        return found;
      })
  : HARNESS_SCAFFOLD_CASES;

if (values.case !== undefined && selectedCases.length === 0) {
  process.stderr.write("Unknown --case: empty\n");
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify(
    {
      model: values.model,
      out: values.out,
      baseline: values.baseline ?? null,
      scaffoldBytes: Buffer.byteLength(T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS, "utf8"),
      cases: selectedCases.map((c) => c.id),
    },
    null,
    2,
  )}\n`,
);
