// Two go: imports of one Go module are entries of one program: they share
// package call, its code and its state.
export { Run as runSync, Calls as calls } from "go:example.com/fixture/src/programs/syncuser";
export { Run as runAsync } from "go:example.com/fixture/src/programs/asyncuser";
