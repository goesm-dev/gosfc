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

/**
 * Builds the props object of a block from props given by name.
 * @param {Record<string, unknown>} zero the block's zero Props value, as JavaScript sees it
 * @param {Record<string, unknown>} attrs
 */
export function readProps(zero, attrs) {
  const props = { ...zero };
  for (const key of Object.keys(zero)) {
    const name = key.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (s) => s.toLowerCase());
    const kebab = name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    const a = key in attrs ? attrs[key] : name in attrs ? attrs[name] : attrs[kebab];
    if (a !== undefined) props[key] = propToGo(zero[key], a);
  }
  return props;
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
