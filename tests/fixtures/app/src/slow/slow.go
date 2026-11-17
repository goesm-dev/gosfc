// Package slow blocks: goesm lowers Load and wait to async functions.
package slow

import "time"

func Load() int {
	return wait()
}

func wait() int {
	time.Sleep(time.Millisecond)
	return 1
}
