package vue

// Ref holds a value that templates, Computeds and watchers follow: they are
// updated after each Set.
type Ref[T any] struct {
	v T
	d dep
}

// NewRef returns a Ref holding v.
func NewRef[T any](v T) *Ref[T] { return &Ref[T]{v: v, d: newDep()} }

// Get returns the value. Read in a template, a Computed or a watcher, it
// subscribes them to the Ref.
func (r *Ref[T]) Get() T {
	r.d.track()
	return r.v
}

// Peek returns the value without subscribing anything to the Ref.
func (r *Ref[T]) Peek() T { return r.v }

// Set replaces the value and updates whatever read it. Setting a value
// equal to the current one changes nothing: == for comparable values,
// Equal for js.Values; values that cannot be compared (slices, maps,
// functions) are never equal.
func (r *Ref[T]) Set(v T) {
	if same(r.v, v) {
		return
	}
	r.v = v
	r.d.trigger()
}

// Trigger updates whatever read the Ref, for a value changed in place (an
// element of a slice, a field behind a pointer).
func (r *Ref[T]) Trigger() { r.d.trigger() }

// same reports whether a and b are equal comparable values, or equal
// js.Values. Values that cannot be compared (slices, maps, functions) are
// never the same.
func same[T any](a, b T) (eq bool) {
	if eq, ok := sameJS(any(a), any(b)); ok {
		return eq
	}
	defer func() {
		if recover() != nil {
			eq = false
		}
	}()
	return any(a) == any(b)
}

// Update replaces the value with f(value).
func (r *Ref[T]) Update(f func(T) T) { r.Set(f(r.v)) }

// GosfcRef marks a Ref for the template bridge of gosfc, which reads a Ref
// binding with Get and writes it (v-model, ref="...") with Set.
func (r *Ref[T]) GosfcRef() bool { return true }

// WatchOption changes how Watch and WatchEffect run.
type WatchOption struct {
	flush string
}

// Flush sets when a watcher runs after what it read changed, as the flush
// option of Vue's watch: "pre" (the default: before the component updates),
// "post" (after Vue updated the page, so the callback sees the new DOM) or
// "sync" (at once, within the Set that changed it).
func Flush(when string) WatchOption { return WatchOption{flush: when} }

// valuer is a Ref or a Computed: Expose reads its current value.
type valuer interface{ value() any }

func (r *Ref[T]) value() any      { return r.Get() }
func (c *Computed[T]) value() any { return c.Get() }
