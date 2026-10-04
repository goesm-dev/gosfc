package syncuser

import "example.com/fixture/src/programs/call"

func Run() int { return call.Call(func() int { return 1 }) }
