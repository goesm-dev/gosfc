// Package call is shared by two programs that compile it differently: in
// one, the func values it calls never block and Call is a plain function; in
// the other, one does and Call is async.
package call

func Call(f func() int) int { return f() }
