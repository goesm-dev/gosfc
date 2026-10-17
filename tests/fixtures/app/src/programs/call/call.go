// Package call is shared by two packages that JavaScript imports with go:.
// They are entries of one program, so Call is async for both (a func value
// passed by asyncuser blocks) and Calls counts the calls of both.
package call

// Calls counts the calls of Call.
var Calls int

func Call(f func() int) int {
	Calls++
	return f()
}
