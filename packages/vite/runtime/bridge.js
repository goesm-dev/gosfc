// Template bindings for <script setup lang="go">.
//
// The lowered setup function (GosfcSetup) runs the Go block once per component
// instance and returns a lookup function: binding name -> current value,
// converted for JavaScript by goesm's JS calling ABI (convert.js).
//
// Each binding is exposed to Vue as a computed ref. Go code mutates ordinary
// Go variables, which Vue cannot observe, so every call of a Go function made
// through a binding (an event handler, a call in the template) bumps a version
// that all bindings of the instance depend on; their values are then read
// again from Go. This is Vue's own reactivity system; there is no separate
// renderer or scheduler.
//
// A binding holding a vue.Ref (package github.com/goesm-dev/gosfc/vue) reads
// as the Ref's value and is followed by Vue whoever sets it (a timer, a
// goroutine, another component); v-model and ref="..." write it with Set.
// A Go function called from the template that reads a Ref is followed the
// same way, since the Ref is read during the render.
//
// A block that declares `type Props struct {...}` receives the component's
// props (its fields, declared as Vue props) as a Props value, and receives
// them again whenever they change: the bindings are then read again, and
// watchers and computeds made with the vue package during setup re-run.

import { computed, getCurrentInstance, onBeforeMount, onBeforeUpdate, onMounted, onUpdated, shallowRef, triggerRef, useAttrs, watch } from "vue";
import { defaultToGo, propNames, propValue, readProps } from "gosfc:convert.js";
import { toTemplate, unview } from "gosfc:handles.js";

/**
 * The options of the Vue props a block's Props fields are declared as: a
 * field whose zero value is a boolean is a Boolean prop, so that Vue casts
 * a bare attribute (<Child open />) to true and a missing one to false; a
 * field with a default tag has that default. Other fields take any value,
 * which the bridge converts to the field's type.
 * @param {() => Record<string, unknown>} props zero value of the block's Props
 * @param {string[]} names the names the fields are declared by
 * @param {Record<string, string>} [defaults] the `default` tags of the fields, by key
 * @returns {Record<string, { type: BooleanConstructor | null, default?: unknown }>}
 */
export function propOptions(props, names, defaults = {}) {
  const zero = props();
  /** @type {Record<string, { type: BooleanConstructor | null, default?: unknown }>} */
  const out = {};
  for (const [key, name] of propNames(zero)) {
    if (!names.includes(name) || name in out) continue;
    out[name] = { type: typeof zero[key] === "boolean" ? Boolean : null };
    if (key in defaults) out[name].default = defaultToGo(zero[key], defaults[key]);
  }
  return out;
}

/**
 * @param {(props?: any) => (name: string) => unknown} setup
 * @param {string} _version hash of the lowered Go code; only there so that
 *   the generated script changes when the Go code does (HMR)
 * @param {() => Record<string, unknown>} [props] zero value of the block's Props
 * @param {Record<string, string>} [defaults] the `default` tags of the Props fields
 * @param {Record<string, unknown>} [declared] the Vue props the Props fields are declared as
 */
export function useGo(setup, _version, props, defaults, declared) {
  const version = shallowRef(0);
  // A Go function called while Vue renders the component (a call in the
  // template) or patches the page with what it rendered (a function ref,
  // :ref="(el) => SetEl(el)") must not invalidate what the render read: the
  // render would run again, and call the function again, forever. Any other
  // call (an event handler) may have changed Go state. Vue sets no current
  // instance while it patches, so the patch is the time from the hooks
  // before the component mounts or updates to the hooks after (or, should
  // they not run because the render failed, to the end of the task: Vue
  // patches synchronously, and event handlers run in tasks of their own).
  let patching = false;
  const changed = () => {
    if (!patching && !getCurrentInstance()) version.value++;
  };
  if (getCurrentInstance()) {
    const end = () => {
      patching = false;
    };
    const start = () => {
      patching = true;
      queueMicrotask(end);
    };
    onBeforeMount(start);
    onBeforeUpdate(start);
    onMounted(end);
    onUpdated(end);
  }
  let lookup;
  if (props) {
    const attrs = useAttrs();
    const zero = props();
    // Read by the vue package's watchers and computeds made during setup.
    const propsVersion = shallowRef(0);
    const inst = getCurrentInstance();
    if (inst) inst.gosfcProps = propsVersion;
    // The fields arrive as the declared props; a field also takes an
    // attribute spelled as its Go name (Size="3").
    lookup = setup(readProps(zero, attrs, defaults, declared));
    const setProps = lookup("gosfc:props");
    // Reading the fields' values is enough to see a prop added, removed or
    // replaced: any read of attrs depends on all of them. Other attributes
    // (class, listeners) do not change the props, so the Go side is told
    // only when a field's value is another.
    const names = propNames(zero);
    const values = () => names.map((n) => propValue(n, attrs, declared));
    let last = values();
    watch(values, (now) => {
      if (now.length === last.length && now.every((v, i) => Object.is(v, last[i]))) return;
      last = now;
      setProps(readProps(zero, attrs, defaults, declared));
      triggerRef(propsVersion);
      changed();
    });
  } else {
    lookup = setup();
  }
  return {
    /** @param {string} name */
    binding(name) {
      const read = () => {
        version.value; // re-read after any Go call
        return lookup(name);
      };
      return computed({
        get() {
          const v = read();
          // A Go function held by a Ref changes Go state like any other.
          // A pointer to a struct with methods is shown as a view of its
          // fields and methods (handles.js).
          if (isRef(v)) return toTemplate(v.Get(), changed);
          return toTemplate(v, changed);
        },
        set(x) {
          const v = read();
          if (!isRef(v) || typeof v.Set !== "function") throw new TypeError(`${name} is not a vue.Ref; only a Ref can be written from the template`);
          // ref="..." sets the same element after every render; only a new
          // value updates what read the Ref.
          x = unview(x);
          if (!Object.is(x, v.Peek())) v.Set(x);
        },
      });
    },
  };
}

// isRef reports whether a binding value is a vue.Ref of the gosfc vue
// package (a goesm handle with the marker method GosfcRef).
function isRef(v) {
  return v !== null && typeof v === "object" && typeof v.GosfcRef === "function";
}
