// Package clock is shared state outside any component.
package clock

import (
	"time"

	"github.com/goesm-dev/gosfc/vue"
)

// Ticks counts the ticks since Start.
var Ticks = vue.NewRef(0)

// Start ticks every interval until n ticks have passed.
func Start(interval time.Duration, n int) {
	go func() {
		for i := 0; i < n; i++ {
			time.Sleep(interval)
			Ticks.Set(Ticks.Get() + 1)
		}
	}()
}
