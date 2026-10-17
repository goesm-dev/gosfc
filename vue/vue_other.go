//go:build !js

package vue

// Without Vue nothing is tracked: values are still held and computed, and
// watchers and hooks never run.

type dep struct{}

func newDep() dep      { return dep{} }
func (d dep) track()   {}
func (d dep) trigger() {}

// Computed is a value derived from Refs (and other Computeds), recomputed
// when one of them changes and only when it is read.
type Computed[T any] struct{ f func() T }

// NewComputed returns a Computed whose value is f().
func NewComputed[T any](f func() T) *Computed[T] { return &Computed[T]{f} }

// GosfcRef marks a Computed for the template bridge of gosfc, which reads a
// Computed binding with Get.
func (c *Computed[T]) GosfcRef() bool { return true }

// Get returns the current value, recomputing it first if needed.
func (c *Computed[T]) Get() T { return c.f() }

// Watch calls cb with the new value each time src() returns a different
// value. It returns a function that stops watching.
func Watch[T comparable](src func() T, cb func(v T)) (stop func()) { return func() {} }

// WatchEffect runs f now and again each time a Ref or Computed it read
// changes. It returns a function that stops watching.
func WatchEffect(f func()) (stop func()) { return func() {} }

// OnMounted runs f once the component is in the page.
func OnMounted(f func()) {}

// OnBeforeUnmount runs f before the component leaves the page.
func OnBeforeUnmount(f func()) {}

// OnUnmounted runs f after the component has left the page.
func OnUnmounted(f func()) {}

// NextTick waits until Vue has updated the page.
func NextTick() {}

// Emitter returns the function that emits the component's events:
// emit("changed") calls the parent's @changed handler, and
// emit("update:modelValue", v) updates its v-model.
func Emitter() func(event string, args ...any) { return func(string, ...any) {} }
