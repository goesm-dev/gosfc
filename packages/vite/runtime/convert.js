// Conversions between the values of a lowered Go block and JavaScript, shared
// by the Vue bridge (bridge.js) and the Astro frontmatter runtime (astro.js).
//
// The lowered setup function (GosfcSetup) runs the Go block once and returns
// a lookup function: binding name -> current value boxed in a Go interface,
// so the value carries its Go type descriptor.
//
// Values are converted with goesm's toJS (strings become JS strings, slices
// arrays, structs plain objects). They are snapshots: changing them in JS does
// not change Go state; call a Go function instead.
//
// A block that declares `type Props struct {...}` receives its props as a
// Props value: field Route is read from the prop `route` (or the field's json
// tag name), also written in kebab case.

import { Kind, fromJSString, toJS } from "@goesm/runtime";

const noop = () => {};

/**
 * Converts a boxed binding value for JavaScript.
 * @param {{ t: any, v: any } | null} x
 * @param {() => void} [changed] called after every call of a Go function
 */
export function fromGo(x, changed = noop) {
  if (x === null) return null;
  if (x.t.kind === Kind.Func) return x.v === null ? null : goFunc(x.t, x.v, changed);
  return toJS(x.t, x.v);
}

function goFunc(t, fn, changed) {
  return (...args) => {
    // Only as many arguments as the Go function declares: an event handler
    // such as @click="Increment" receives the DOM event, which a Go
    // `func Increment()` does not take.
    const goArgs = t.params.map((p, i) => toGo(p, args[i]));
    let r;
    try {
      r = fn(...goArgs);
    } catch (e) {
      changed();
      throw e;
    }
    if (r instanceof Promise) {
      // A blocking Go function (channels, ...) returns a Promise.
      return r.then(
        (v) => {
          changed();
          return result(t, v);
        },
        (e) => {
          changed();
          throw e;
        },
      );
    }
    changed();
    return result(t, r);
  };
}

function toGo(t, v) {
  if (t.kind === Kind.String && typeof v === "string") return fromJSString(v);
  return v;
}

/**
 * Fills the zero Props value of a block from props given by name.
 * @param {{ t: any, v: any }} zero
 * @param {Record<string, unknown>} attrs
 */
export function readProps(zero, attrs) {
  const v = zero.v;
  for (const f of zero.t.fields) {
    if (f.pkgPath !== "") continue; // unexported
    const tag = /json:"([^",]*)/.exec(f.tag)?.[1];
    if (tag === "-") continue;
    const name = tag || f.name.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (s) => s.toLowerCase());
    const kebab = name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    const a = name in attrs ? attrs[name] : attrs[kebab];
    if (a !== undefined) v[f.prop] = propToGo(f.type, a);
  }
  return v;
}

function propToGo(t, a) {
  switch (t.kind) {
    case Kind.String:
      return fromJSString(String(a));
    case Kind.Bool:
      return a === "" || a === true || a === "true";
    case Kind.Int64:
    case Kind.Uint64:
      return BigInt(a);
    case Kind.Float32:
    case Kind.Float64:
      return Number(a);
    case Kind.Int:
    case Kind.Int8:
    case Kind.Int16:
    case Kind.Int32:
    case Kind.Uint:
    case Kind.Uint8:
    case Kind.Uint16:
    case Kind.Uint32:
    case Kind.Uintptr:
      return Math.trunc(Number(a));
  }
  return a;
}

function result(t, r) {
  if (t.results.length === 0) return undefined;
  if (t.results.length === 1) return toJS(t.results[0], r);
  return t.results.map((rt, i) => toJS(rt, r[i]));
}
