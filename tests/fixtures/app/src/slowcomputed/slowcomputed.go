// Package slowcomputed makes vue.Computeds whose getters block, which gosfc
// reports in the components that import the package.
package slowcomputed

import (
	"time"

	"github.com/goesm-dev/gosfc/vue"
)

func total() int {
	time.Sleep(time.Millisecond)
	return 3
}

// Total's getter is a function that blocks.
var Total = vue.NewComputed(total)

type Counter struct{ n int }

func (c *Counter) Count() int {
	time.Sleep(time.Millisecond)
	return c.n
}

// Count's getter is a method value that blocks.
func Count(c *Counter) *vue.Computed[int] { return vue.NewComputed(c.Count) }
