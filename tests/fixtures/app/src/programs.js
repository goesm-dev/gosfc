// Two go: imports are two goesm programs that share package call but do not
// agree on its code.
export { Run as runSync } from "go:example.com/fixture/src/programs/syncuser";
export { Run as runAsync } from "go:example.com/fixture/src/programs/asyncuser";
