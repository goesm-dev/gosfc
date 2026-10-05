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
// A block that declares `type Props struct {...}` receives the component's
// attributes as a Props value. Props are read once, when the instance is set
// up, like the rest of the block.

import { computed, shallowRef, useAttrs } from "vue";
import { fromGo, readProps } from "gosfc:convert.js";

/**
 * @param {(props?: any) => (name: string) => unknown} setup
 * @param {string} _version hash of the lowered Go code; only there so that
 *   the generated script changes when the Go code does (HMR)
 * @param {() => Record<string, unknown>} [props] zero value of the block's Props
 */
export function useGo(setup, _version, props) {
  const lookup = props ? setup(readProps(props(), useAttrs())) : setup();
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
