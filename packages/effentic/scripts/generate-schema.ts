// Generates `src/AgUiSchema.ts` from the pinned AG-UI JSON Schema
// (`schema/ag-ui-1.0.json`, a copy of https://docs.ag-ui.com/spec/1.0/schema.json)
// with Effect's own JSON Schema importer and code generator.
//
// Run with `pnpm --filter effentic generate:schema`. To move to a new spec
// version, replace the pinned file and regenerate.
//
// The importer accepts a subset of draft 2020-12, so the document is rewritten
// first:
//
// - `allOf` is flattened. The spec composes events and messages from open
//   fragments (`BaseEvent`, `Attributable`, `BaseMessage`) and closes the result
//   with `unevaluatedProperties: false`; each definition becomes one object with
//   the fragments' properties and `required` merged in, its own properties
//   taking precedence (an event narrows `type` to a `const`).
// - `unevaluatedProperties: false` becomes `additionalProperties: false`, which
//   is equivalent once `allOf` is gone.
// - `not: { type: "null" }` ("any JSON value but null") is dropped, leaving any
//   JSON value: Effect has no negation, and nothing here relies on rejecting a
//   null.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { JsonSchema, SchemaRepresentation } from "effect";

type Node = { readonly [key: string]: unknown };

const root = Path.join(import.meta.dirname, "..");
const source = Path.join(root, "schema", "ag-ui-1.0.json");
const target = Path.join(root, "src", "AgUiSchema.ts");

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

const asNode = (value: unknown): Node => (isNode(value) ? value : {});

const flatten = (definitions: Node, node: Node): Node => {
  const { allOf, ...rest } = node;
  if (!Array.isArray(allOf)) {
    return node;
  }
  const properties: Record<string, Node> = {};
  const required = new Set<string>();
  const merge = (part: Node) => {
    for (const [key, value] of Object.entries(asNode(part["properties"]))) {
      properties[key] = { ...properties[key], ...asNode(value) };
    }
    for (const key of Array.isArray(part["required"]) ? part["required"] : []) {
      required.add(String(key));
    }
  };
  for (const part of allOf.map(asNode)) {
    const ref = part["$ref"];
    merge(flatten(definitions, typeof ref === "string" ? asNode(definitions[ref.replace("#/$defs/", "")]) : part));
  }
  merge(rest);
  for (const [key, value] of Object.entries(properties)) {
    if ("const" in value) {
      const { $ref: _, ...narrowed } = value;
      properties[key] = narrowed;
    }
  }
  return { ...rest, properties, required: [...required] };
};

const rewrite = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(rewrite);
  }
  if (!isNode(value)) {
    return value;
  }
  const { not, unevaluatedProperties, ...rest } = value;
  const node = Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, rewrite(child)]));
  if (not !== undefined && !(isNode(not) && not["type"] === "null")) {
    throw new Error(`Unsupported "not": ${JSON.stringify(not)}`);
  }
  if (unevaluatedProperties === false) {
    node["additionalProperties"] = false;
  } else if (unevaluatedProperties !== undefined) {
    throw new Error(`Unsupported "unevaluatedProperties": ${JSON.stringify(unevaluatedProperties)}`);
  }
  return node;
};

const raw = asNode(JSON.parse(Fs.readFileSync(source, "utf8")));
const definitions = asNode(raw["$defs"]);
const flattened = Object.fromEntries(
  Object.entries(definitions).map(([key, definition]) => [key, flatten(definitions, asNode(definition))]),
);
const prepared = rewrite({ ...raw, $defs: flattened }) as JsonSchema.JsonSchema;

const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(prepared), {
  // The only pattern is `JsonPointer`'s, from a document we pin.
  patterns: "apply",
});
const code = SchemaRepresentation.toCodeDocument(
  SchemaRepresentation.toMultiDocument(SchemaRepresentation.toRepresentation(schema.ast)),
);
if (Object.keys(code.references.recursives).length > 0 || code.artifacts.length > 0) {
  throw new Error("The generator does not handle recursive definitions or auxiliary artifacts yet");
}

const version = /\/spec\/([^/]+)\/schema\.json$/.exec(String(raw["$id"]))?.[1];
if (version === undefined) {
  throw new Error(`Cannot read the protocol version from $id ${String(raw["$id"])}`);
}

const comment = (text: unknown) =>
  typeof text === "string" ? `/**\n${text.replaceAll("*/", "*\\/").replace(/^/gm, " * ")}\n */\n` : "";

// JSON has no `NaN` or `Infinity`, so every JSON Schema number is finite.
const finite = (runtime: string) => runtime.replaceAll(/\bSchema\.Number\b/g, "Schema.Finite");

const declarations = code.references.nonRecursives.map(
  ({ $ref, code }) =>
    `${comment(asNode(definitions[$ref])["description"])}export const ${$ref} = ${finite(code.runtime)};\nexport type ${$ref} = ${code.Type};\n`,
);

Fs.writeFileSync(
  target,
  [
    `// Generated by scripts/generate-schema.ts from schema/ag-ui-1.0.json. Do not edit.\n`,
    `import { Schema } from "effect";\n`,
    `/** The AG-UI protocol version these schemas describe. */\nexport const PROTOCOL_VERSION = ${JSON.stringify(version)};\n`,
    ...declarations,
  ].join("\n"),
);
