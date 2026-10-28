//go:build js

package vue

import "syscall/js"

//goesm:import "vue" shallowRef
func shallowRef(v any) js.Value

//goesm:import "vue" triggerRef
func triggerRef(r js.Value)

//goesm:import "vue" computed
func jsComputed(get func() int) js.Value

//goesm:import "vue" watch
func jsWatch(src func() int, cb func()) js.Value

//goesm:import "vue" watchEffect
func jsWatchEffect(f func()) js.Value

//goesm:import "vue" getCurrentInstance
func getCurrentInstance() js.Value

//goesm:import "vue" onMounted
func onMounted(f func())

//goesm:import "vue" onBeforeUnmount
func onBeforeUnmount(f func())

//goesm:import "vue" onUnmounted
func onUnmounted(f func())

//goesm:import "./call.js" call
func call(f js.Value, args ...any)

//goesm:import "vue" nextTick await
func nextTick()

// dep is what Vue tracks for a Go value: reading it inside a render, a
// computed or a watcher subscribes that effect, triggering it re-runs them.
type dep struct{ r js.Value }

func newDep() dep      { return dep{shallowRef(0)} }
func (d dep) track()   { d.r.Get("value") }
func (d dep) trigger() { triggerRef(d.r) }

// propsDep is the props version of the component being set up, so watchers
// and computeds made in its setup also re-run when its props change.
func propsDep() js.Value {
	inst := getCurrentInstance()
	if inst.Truthy() {
		if p := inst.Get("gosfcProps"); p.Truthy() {
			return p
		}
	}
	return js.Undefined()
}

func readProps(p js.Value) {
	if p.Truthy() {
		p.Get("value")
	}
}

// Computed is a value derived from Refs (and other Computeds), recomputed
// when one of them changes and only when it is read.
type Computed[T any] struct {
	v T
	c js.Value
}

// NewComputed returns a Computed whose value is f().
func NewComputed[T any](f func() T) *Computed[T] {
	c := &Computed[T]{}
	props := propsDep()
	n := 0
	c.c = jsComputed(func() int {
		readProps(props)
		c.v = f()
		n++
		return n
	})
	return c
}

// GosfcRef marks a Computed for the template bridge of gosfc, which reads a
// Computed binding with Get.
func (c *Computed[T]) GosfcRef() bool { return true }

// Get returns the current value, recomputing it first if needed.
func (c *Computed[T]) Get() T {
	c.c.Get("value")
	return c.v
}

// Watch calls cb with the new value each time src() returns a different
// value. It returns a function that stops watching.
func Watch[T comparable](src func() T, cb func(v T)) (stop func()) {
	props := propsDep()
	var last T
	first := true
	// n counts the values src returned, seen the ones cb was called with.
	n, seen := 0, 0
	running, late := false, false
	fire := func() {
		if n != seen {
			seen = n
			cb(last)
		}
	}
	h := jsWatch(func() int {
		running = true
		readProps(props)
		v := src()
		if first {
			first, last = false, v
			n++
			seen = n
		} else if v != last {
			last = v
			n++
		}
		running = false
		if late {
			late = false
			fire()
		}
		return n
	}, func() {
		// goesm makes this getter async (src may be), so Vue sees a new
		// Promise each time and calls back whenever anything src read
		// changes: only a new value counts. A src that blocks is still
		// running here; the getter then calls cb itself when it returns.
		if running {
			late = true
			return
		}
		fire()
	})
	return func() { h.Invoke() }
}

// WatchEffect runs f now and again each time a Ref or Computed it read
// changes. It returns a function that stops watching.
func WatchEffect(f func()) (stop func()) {
	props := propsDep()
	h := jsWatchEffect(func() {
		readProps(props)
		f()
	})
	return func() { h.Invoke() }
}

// OnMounted runs f once the component is in the page.
func OnMounted(f func()) { onMounted(f) }

// OnBeforeUnmount runs f before the component leaves the page.
func OnBeforeUnmount(f func()) { onBeforeUnmount(f) }

// OnUnmounted runs f after the component has left the page.
func OnUnmounted(f func()) { onUnmounted(f) }

// NextTick waits until Vue has updated the page.
func NextTick() { nextTick() }

// Emitter returns the function that emits the component's events:
// emit("changed") calls the parent's @changed handler, and
// emit("update:modelValue", v) updates its v-model.
func Emitter() func(event string, args ...any) {
	e := getCurrentInstance().Get("emit")
	return func(event string, args ...any) {
		a := make([]any, 0, len(args)+1)
		a = append(a, event)
		a = append(a, args...)
		call(e, a...)
	}
}
