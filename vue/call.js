// call(f, ...args) calls the JavaScript function f. Go code uses it through
// //goesm:import to pass values of any Go type, converted by goesm, to a
// function it holds as a js.Value.
export function call(f, ...args) {
  return f(...args);
}
