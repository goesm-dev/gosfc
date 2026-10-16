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
// attributes as a Props value, and receives them again whenever they change:
// the bindings are then read again, and watchers and computeds made with the
// vue package during setup re-run.

import { computed, getCurrentInstance, shallowRef, triggerRef, useAttrs, watch } from "vue";
import { fromGo, readProps } from "gosfc:convert.js";

/**
 * @param {(props?: any) => (name: string) => unknown} setup
 * @param {string} _version hash of the lowered Go code; only there so that
 *   the generated script changes when the Go code does (HMR)
 * @param {() => Record<string, unknown>} [props] zero value of the block's Props
 * @param {Record<string, string>} [defaults] the `default` tags of the Props fields
 */
export function useGo(setup, _version, props, defaults) {
  const version = shallowRef(0);
  // A Go function called while Vue renders (a call in the template) must
  // not invalidate what the render reads, or the render would run again
  // forever; any other call (an event handler) may have changed Go state.
  const changed = () => {
    if (!getCurrentInstance()) version.value++;
  };
  let lookup;
  if (props) {
    const attrs = useAttrs();
    const zero = props();
    // Read by the vue package's watchers and computeds made during setup.
    const propsVersion = shallowRef(0);
    const inst = getCurrentInstance();
    if (inst) inst.gosfcProps = propsVersion;
    lookup = setup(readProps(zero, attrs, defaults));
    const setProps = lookup("gosfc:props");
    // attrs is reactive but not deeply: read every key so that a prop added,
    // removed or replaced is noticed.
    watch(
      () => Object.keys(attrs).map((k) => attrs[k]),
      () => {
        setProps(readProps(zero, attrs, defaults));
        triggerRef(propsVersion);
        changed();
      },
    );
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
          if (isRef(v)) return v.Get();
          return fromGo(v, changed);
        },
        set(x) {
          const v = read();
          if (!isRef(v) || typeof v.Set !== "function") throw new TypeError(`${name} is not a vue.Ref; only a Ref can be written from the template`);
          // ref="..." sets the same element after every render; only a new
          // value updates what read the Ref.
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
