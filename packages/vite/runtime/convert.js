// Values of a lowered Go block for JavaScript, shared by the Vue bridge
// (bridge.js) and the Astro frontmatter runtime (astro.js).
//
// The lowered setup function (GosfcSetup) is an exported function of the
// component's package, so goesm's JS calling ABI converts what crosses it
// (goesm docs/js-exports.md): the setup function returns a lookup function
// from binding name to the binding's current value as JavaScript sees it
// (strings are JS strings, slices arrays, structs plain objects, functions
// functions that convert their own arguments and results). Values are
// snapshots: changing them in JS does not change Go state; call a Go
// function instead.
//
// A block that declares `type Props struct {...}` receives its props as a
// Props value, which the ABI fills from a plain object keyed like
// encoding/json (the json tag name, or the field name). Field Route is also
// read from the prop `route`, and from its kebab-case form.

const noop = () => {};

/**
 * Wraps a binding value for JavaScript: a function reports every call
 * through `changed`, once it has returned (or its Promise has settled).
 * @param {unknown} x
 * @param {() => void} [changed]
 */
export function fromGo(x, changed = noop) {
  if (typeof x !== "function" || changed === noop) return x;
  return (...args) => {
    let r;
    try {
      r = x(...args);
    } catch (e) {
      changed();
      throw e;
    }
    if (r instanceof Promise) {
      // A blocking Go function (channels, ...) returns a Promise.
      return r.then(
        (v) => {
          changed();
          return v;
        },
        (e) => {
          changed();
          throw e;
        },
      );
    }
    changed();
    return r;
  };
}

// The names a field's prop arrives under, by the field keys of a zero Props
// value: the key itself, the name Vue normalizes the declared name to
// (camelize, so a json tag such as "display-name" is the prop displayName),
// and its kebab-case spelling. Components of one type share their keys.
const namesCache = new Map();

/**
 * @param {Record<string, unknown>} zero
 * @returns {[string, string, string][]} [key, name, kebab] for each field
 */
export function propNames(zero) {
  const keys = Object.keys(zero);
  const id = keys.join("\0");
  let names = namesCache.get(id);
  if (!names) {
    names = keys.map((key) => {
      const name = key.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (s) => s.toLowerCase()).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      return [key, name, name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())];
    });
    namesCache.set(id, names);
  }
  return names;
}

/**
 * The value given for a field under one of its names, or undefined. The
 * declared props take precedence over the attributes.
 * @param {[string, string, string]} n
 * @param {Record<string, unknown>} attrs
 * @param {Record<string, unknown>} [declared]
 */
export function propValue([key, name, kebab], attrs, declared) {
  for (const k of [key, name]) {
    if (declared && k in declared) return declared[k];
    // Vue tracks a read of attrs, not an `in`: read first.
    const v = attrs[k];
    if (v !== undefined || k in attrs) return v;
  }
  return declared && kebab in declared ? declared[kebab] : attrs[kebab];
}

/**
 * Builds the props object of a block from props given by name. A prop that
 * is not given takes the field's `default:"..."` tag, if it has one.
 * @param {Record<string, unknown>} zero the block's zero Props value, as JavaScript sees it
 * @param {Record<string, unknown>} attrs
 * @param {Record<string, string>} [defaults] the `default` tags, by key
 * @param {Record<string, unknown>} [declared] the declared props, which take precedence over attrs
 */
export function readProps(zero, attrs, defaults = {}, declared) {
  const props = { ...zero };
  for (const n of propNames(zero)) {
    const key = n[0];
    const a = propValue(n, attrs, declared);
    if (a !== undefined) props[key] = propToGo(zero[key], a);
    else if (key in defaults) props[key] = defaultToGo(zero[key], defaults[key]);
  }
  return props;
}

// defaultToGo converts a default tag for the field whose zero value is zero.
function defaultToGo(zero, d) {
  switch (typeof zero) {
    case "number":
      return Number(d);
    case "boolean":
      return d === "true";
    case "bigint":
      return BigInt(d);
  }
  return d;
}

// propToGo converts an attribute for the field whose zero value is zero.
// The ABI converts numbers and strings itself (an int field takes "3");
// a boolean attribute is present ("") or the string "true", and a 64-bit
// integer is read exactly.
function propToGo(zero, a) {
  switch (typeof zero) {
    case "boolean":
      return a === "" || a === true || a === "true";
    case "bigint":
      try {
        return BigInt(a);
      } catch {
        return a;
      }
  }
  return a;
}
