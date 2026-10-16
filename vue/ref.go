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
// equal to the current one (==, for comparable values) changes nothing.
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

// same reports whether a and b are equal comparable values. Values that
// cannot be compared (slices, maps, functions) are never the same.
func same[T any](a, b T) (eq bool) {
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
