// canvas-kit/validate.mjs
//
// A tiny, dependency-free JSON-Schema-*subset* validator. It exists so the
// runtime can ENFORCE the action `inputSchema` (and an optional `stateSchema`)
// that authors already declare — turning the iframe↔extension / agent↔extension
// contract from "declared but unchecked" into "validated at the boundary". No
// npm dependency (the kit ships vendored, no install step), and it only covers
// the JSON Schema features the kit's schemas actually use:
//
//   type            "object" | "array" | "string" | "number" | "integer" |
//                   "boolean" | "null"  (or an array of those)
//   properties      per-key subschemas (objects)
//   required        array of required property names (objects)
//   additionalProperties   false | subschema (objects)
//   items           subschema for every element (arrays)
//   enum            allowed literal values (deep-equal)
//   minLength/maxLength    string length bounds
//   minimum/maximum        numeric bounds
//   minItems/maxItems      array length bounds
//
// It is intentionally forgiving: an absent/empty schema validates anything, and
// unknown keywords are ignored (so a richer schema never hard-fails here). A
// property whose value is `undefined` is treated as ABSENT — `undefined` is not a
// JSON value, so `{ x: undefined }` is equivalent to `{}` once it crosses the
// agent↔extension / iframe↔extension boundary, and `{ optional }` shorthand with
// an unset variable must not be rejected. The goal is to catch the shape mistakes
// that actually break canvases — wrong type, missing required field, unknown/typo'd
// property, out-of-enum value — not to be a complete JSON Schema implementation.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value; // "string" | "number" | "boolean" | "object" | "undefined"
}

// Does `value` satisfy a single JSON Schema `type` token? "number" accepts
// integers; "integer" requires a whole number.
function matchesType(value, t) {
  const actual = typeOf(value);
  if (t === "number") return actual === "number" || actual === "integer";
  if (t === "integer") return actual === "integer";
  return actual === t;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Validate `value` against a JSON-Schema-subset `schema`.
 * @param {object|undefined} schema
 * @param {any} value
 * @param {string} [path]  dotted path used in error messages (default "input")
 * @returns {string[]} human-readable error messages; empty array = valid.
 */
export function validate(schema, value, path = "input") {
  const errors = [];
  walk(schema, value, path, errors);
  return errors;
}

function walk(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return; // absent/degenerate schema = anything goes

  // type (single token or array of tokens)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(" | ")}, got ${typeOf(value)}`);
      return; // a wrong base type makes deeper checks meaningless
    }
  }

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => deepEqual(allowed, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  const kind = typeOf(value);

  if (kind === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} characters`);
    }
  }

  if (kind === "number" || kind === "integer") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (kind === "array") {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  if (kind === "object") {
    const props = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        // Object.hasOwn (not `value[key] === undefined`): a required property
        // named after a prototype member (e.g. "toString", "constructor") would
        // otherwise read the inherited value and wrongly pass the check. An
        // explicit `undefined` counts as ABSENT (undefined is not a JSON value, so
        // { x: undefined } is equivalent to {} once it crosses the wire).
        if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`${path}.${key}: required`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      // Skip absent OR explicitly-undefined optional properties: a caller passing
      // { article } where `article` is an unset variable is idiomatic JS and, over
      // a JSON boundary, indistinguishable from omitting the key. Only validate a
      // property that is actually present with a defined value.
      if (Object.hasOwn(value, key) && value[key] !== undefined) walk(sub, value[key], `${path}.${key}`, errors);
    }
    // Membership is tested with Object.hasOwn, NOT `key in props`: `in` walks the
    // prototype chain, so an extra key named "toString"/"constructor"/"__proto__"
    // etc. would satisfy `key in props` and escape additionalProperties. This
    // validator is the enforcement boundary (input → 400, state → 500), so that
    // would be a real contract hole. An explicit `undefined` value is treated as
    // absent (see above), so it is never counted as an extra/unexpected property.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        if (!Object.hasOwn(props, key)) errors.push(`${path}.${key}: unexpected property`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        if (!Object.hasOwn(props, key)) walk(schema.additionalProperties, value[key], `${path}.${key}`, errors);
      }
    }
  }
}
