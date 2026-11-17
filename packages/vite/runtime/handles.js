// Go objects in templates.
//
// goesm's JS calling ABI copies a struct to a plain object with its fields
// converted, but hands out a pointer to a struct type with methods as the
// Go object itself, a handle (goesm docs/js-exports.md): its methods are
// callable, and its fields hold Go's own representation under their Go names
// (a Go string is not a JS string; a json or js tag names nothing). A
// template reading {{ Get().x }} of such a pointer would read undefined.
//
// What a template receives from Go (a binding's value, the result of a Go
// function it calls) is therefore shown with every handle in it replaced by
// a view: a plain object of the handle's fields as the ABI converts a struct
// (named by their js or json tags, values converted), whose non-enumerable
// methods call the handle's. A view passed back to a Go function (an event
// handler's argument) is the handle again, so Go receives its own object.
// The fields of a view are read when the view is made, a snapshot like any
// other binding value; a field holding another handle is a view made when it
// is read, so cyclic structures cost nothing until they are read. A method
// call reports a change like any other Go call.
//
// The conversion is goesm's (goToJS of the struct type with the handles
// kept, and classTypes for the type of a Go object), from the goesm runtime
// the components' modules import.

import { Kind, classTypes } from "gosfc:goesm/@goesm/runtime/index.ts";
import { goToJS } from "gosfc:goesm/@goesm/runtime/jsabi.ts";
import { fromGo } from "gosfc:convert.js";

const VIEW = Symbol("gosfc handle");

/**
 * A value from Go for the template: a function calls Go with the handles of
 * its view arguments and shows its result; other values are shown.
 * @param {unknown} x
 * @param {() => void} [changed] reported after each call of a Go function
 */
export function toTemplate(x, changed) {
  if (typeof x !== "function") return show(x, changed, new Map());
  const f = fromGo((...args) => x(...args.map(unview)), changed);
  return (...args) => {
    const r = f(...args);
    return r instanceof Promise ? r.then((v) => show(v, changed, new Map())) : show(r, changed, new Map());
  };
}

/** The handle of a view, or x itself. */
export function unview(x) {
  return x !== null && typeof x === "object" && x[VIEW] ? x[VIEW] : x;
}

/** The struct type of a Go object, or null for any other value. */
function goStruct(x) {
  const t = classTypes?.get(Object.getPrototypeOf(x)?.constructor);
  return t && t.kind === Kind?.Struct && typeof goToJS === "function" ? t : null;
}

/**
 * x with the handles in it replaced by views; x itself when it has none.
 * @param {unknown} x
 * @param {(() => void) | undefined} changed
 * @param {Map<object, object>} views the views made by this showing, by handle
 */
function show(x, changed, views) {
  if (x === null || typeof x !== "object" || x[VIEW]) return x;
  const t = goStruct(x);
  if (t) return view(x, t, changed, views);
  const proto = Object.getPrototypeOf(x);
  if (!Array.isArray(x) && proto !== Object.prototype && proto !== null) return x;
  let out = null;
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (v === null || typeof v !== "object") continue;
    const s = show(v, changed, views);
    if (s !== v) (out ??= Array.isArray(x) ? x.slice() : { ...x })[k] = s;
  }
  return out ?? x;
}

/** The view of the handle h of struct type t. */
function view(h, t, changed, views) {
  const seen = views.get(h);
  if (seen) return seen;
  const v = {};
  views.set(h, v);
  Object.defineProperty(v, VIEW, { value: h });
  const fields = goToJS(t, h, true);
  for (const k of Object.keys(fields)) {
    const f = fields[k];
    if (f === null || typeof f !== "object") {
      v[k] = f;
      continue;
    }
    let shown;
    Object.defineProperty(v, k, {
      enumerable: true,
      configurable: true,
      get: () => (shown ??= { value: show(f, changed, views) }).value,
    });
  }
  // The exported methods: own (added by the ABI to a handle it could not see
  // coming) and of the class.
  for (let o = h; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k in v || !/^\p{Lu}/u.test(k) || typeof h[k] !== "function") continue;
      Object.defineProperty(v, k, { value: toTemplate(h[k].bind(h), changed), configurable: true });
    }
  }
  return v;
}
