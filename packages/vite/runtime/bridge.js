// Template bindings for <script setup lang="go">.
//
// The lowered setup function (GosfcSetup) runs the Go block once per component
// instance and returns a lookup function: binding name -> current value boxed
// in a Go interface, so the value carries its Go type descriptor.
//
// Each binding is exposed to Vue as a computed ref. Go code mutates ordinary
// Go variables, which Vue cannot observe, so every call of a Go function made
// through a binding (an event handler, a call in the template) bumps a version
// that all bindings of the instance depend on; their values are then read
// again from Go. This is Vue's own reactivity system; there is no separate
// renderer or scheduler.
//
// Values are converted for the template with goesm's toJS (strings become JS
// strings, slices arrays, structs plain objects). They are snapshots: changing
// them in JS does not change Go state; call a Go function instead.

import { computed, shallowRef } from "vue";
import { Kind, fromJSString, toJS } from "@goesm/runtime";

/**
 * @param {() => (name: string) => { t: any, v: any } | null} setup
 * @param {string} _version hash of the lowered Go code; only there so that
 *   the generated script changes when the Go code does (HMR)
 */
export function useGo(setup, _version) {
  const lookup = setup();
  const version = shallowRef(0);
  const changed = () => {
    version.value++;
  };
  return {
    /** @param {string} name */
    binding(name) {
      return computed(() => {
        version.value; // re-read after any Go call
        return fromGo(lookup(name), changed);
      });
    },
  };
}

function fromGo(x, changed) {
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

function result(t, r) {
  if (t.results.length === 0) return undefined;
  if (t.results.length === 1) return toJS(t.results[0], r);
  return t.results.map((rt, i) => toJS(rt, r[i]));
}
