// This file imports nothing: it is served from wherever the gosfc Go module
// is, such as the module cache, where a bare import like "vue" does not
// resolve to the project's copy. Go passes the values it needs.

// call(f, ...args) calls the JavaScript function f. Go code uses it through
// //goesm:import to pass values of any Go type, converted by goesm, to a
// function it holds as a js.Value.
export function call(f, ...args) {
  return f(...args);
}

// expose(inst, name, get) adds the property name to what the component
// instance inst, the one being set up, exposes (vue.Expose): reading it calls
// get, and shows its value as the bridge shows the template a value (runtime/bridge.js gives the instance
// gosfcExposed and gosfcShow).
export function expose(inst, name, get) {
  const exposed = inst?.gosfcExposed;
  if (!exposed) throw new Error("vue.Expose must be called from the top level of a <script setup lang=\"go\"> block");
  Object.defineProperty(exposed, name, { enumerable: true, configurable: true, get: () => inst.gosfcShow(get()) });
}
