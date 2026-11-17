// Package slowdyn blocks through calls whose callees only the whole program
// tells: an interface method and a function value.
package slowdyn

import "time"

// A Source gives the next value.
type Source interface{ Next() int }

type ticker struct{}

func (ticker) Next() int {
	time.Sleep(time.Millisecond)
	return 1
}

type fixed int

func (f fixed) Next() int { return int(f) }

// Sources are the program's sources: one of them blocks.
var Sources = []Source{fixed(1), ticker{}}

// First reads the first source through the interface.
func First() int { return Sources[0].Next() }

// Hook is called by Run.
var Hook = func() string { return "hook" }

// Run calls the function value Hook.
func Run() string { return Hook() }

func init() {
	hooks := map[bool]func() string{true: slowHook}
	Hook = hooks[true]
}

func slowHook() string {
	time.Sleep(time.Millisecond)
	return "slow"
}
