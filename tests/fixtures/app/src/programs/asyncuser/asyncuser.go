package asyncuser

import "example.com/fixture/src/programs/call"

func Run() int {
	return call.Call(func() int {
		ch := make(chan int)
		go func() { ch <- 2 }()
		return <-ch
	})
}
