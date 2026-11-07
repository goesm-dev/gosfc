// How the Vue bridge reads a block's Props fields from the declared props
// and the attributes (packages/vite/runtime/convert.js), and that watching
// the fields' values follows a prop of Vue's attrs being added or replaced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reactive, watch, nextTick } from "vue";
import { propNames, propValue, readProps } from "../packages/vite/runtime/convert.js";

const zero = { Route: "", "display-name": "", Size: 0 };

test("propNames: key, camelized name and kebab-case name, shared by components of one type", () => {
  assert.deepEqual(propNames(zero), [
    ["Route", "route", "route"],
    ["display-name", "displayName", "display-name"],
    ["Size", "size", "size"],
  ]);
  assert.equal(propNames({ ...zero }), propNames(zero));
});

test("propValue: declared props take precedence, then the key, the name and the kebab-case name", () => {
  const [route, display] = propNames(zero);
  assert.equal(propValue(route, { Route: "a", route: "b" }), "a");
  assert.equal(propValue(route, { route: "b" }), "b");
  assert.equal(propValue(route, { Route: "a" }, { Route: "d" }), "d");
  // A declared prop the parent leaves out is undefined, as Vue gives it.
  assert.equal(propValue(route, { Route: "a" }, { Route: undefined }), undefined);
  assert.equal(propValue(display, { "display-name": "k" }), "k");
  assert.equal(propValue(display, { displayName: "c" }), "c");
  assert.equal(propValue(route, {}), undefined);
});

test("readProps: given values, then default tags, then the zero value", () => {
  const p = readProps(zero, { route: "/x" }, { Size: "20" }, { "display-name": "n" });
  assert.deepEqual(p, { Route: "/x", "display-name": "n", Size: 20 });
});

test("the fields' values follow attrs that are added and replaced, not other attributes", async () => {
  const attrs = reactive({ class: "a" });
  const names = propNames(zero);
  const runs = [];
  watch(
    () => names.map((n) => propValue(n, attrs)),
    (v) => runs.push(v),
  );
  attrs.route = "/x";
  await nextTick();
  attrs.class = "b";
  await nextTick();
  attrs.route = "/y";
  await nextTick();
  assert.deepEqual(runs, [
    ["/x", undefined, undefined],
    ["/y", undefined, undefined],
  ]);
});
