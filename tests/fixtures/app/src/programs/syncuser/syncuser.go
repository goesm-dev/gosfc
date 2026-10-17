package syncuser

import "example.com/fixture/src/programs/call"

func Run() int { return call.Call(func() int { return 1 }) }

// Calls reads the state of the package both users share.
func Calls() int { return call.Calls }
