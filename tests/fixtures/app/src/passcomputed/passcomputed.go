// Package passcomputed makes a vue.Computed whose getter is a function of
// another package that blocks; no function of its own blocks.
package passcomputed

import (
	"example.com/fixture/src/slow"
	"github.com/goesm-dev/gosfc/vue"
)

// Loaded's getter blocks in package slow.
var Loaded = vue.NewComputed(slow.Load)
