import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from "@tldraw/tlschema";

/**
 * Schema for a board sync room. Shapes and bindings are passed explicitly: the
 * bindings key is load-bearing, because arrow bindings (an arrow shape plus its
 * start/end binding records) are rejected by a schema that only registers
 * shapes. Client and server must share this schema — both sides are pinned to
 * one tldraw version via the root package overrides.
 */
export const boardSchema = createTLSchema({
  shapes: defaultShapeSchemas,
  bindings: defaultBindingSchemas,
});
