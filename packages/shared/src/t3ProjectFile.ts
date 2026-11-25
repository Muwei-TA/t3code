import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { T3ProjectFile, T3_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

const decodeProjectFileUnknown = Schema.decodeUnknownEffect(T3ProjectFile);

// Isolate an invalid `harness` section so bad MCP entries never discard worktree/project settings.
const decodeWithIsolatedHarness = SchemaGetter.transformEffect((value: unknown) =>
  decodeProjectFileUnknown(value).pipe(
    Effect.catch((directError) => {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, "harness")
      ) {
        const { harness: _ignored, ...withoutHarness } = value as Record<string, unknown>;
        return decodeProjectFileUnknown(withoutHarness).pipe(
          Effect.mapError(() => directError.issue),
        );
      }
      return Effect.fail(directError.issue);
    }),
  ),
);

const T3ProjectFileWithIsolatedHarness = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.toType(T3ProjectFile),
    new SchemaTransformation.Transformation(
      decodeWithIsolatedHarness,
      SchemaGetter.transform((value: T3ProjectFile): unknown => value),
    ),
  ),
);

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFileWithIsolatedHarness);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
