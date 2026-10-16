package vue

import "testing"

// Outside goesm, Refs and Computeds hold and compute values.
func TestRefAndComputed(t *testing.T) {
	n := NewRef(1)
	double := NewComputed(func() int { return n.Get() * 2 })
	n.Set(4)
	n.Update(func(v int) int { return v + 1 })
	if n.Get() != 5 || n.Peek() != 5 || double.Get() != 10 {
		t.Fatalf("n=%d double=%d", n.Get(), double.Get())
	}
	if !n.GosfcRef() || !double.GosfcRef() {
		t.Fatal("GosfcRef")
	}
}

func TestSame(t *testing.T) {
	if !same(1, 1) || same(1, 2) {
		t.Error("ints")
	}
	if same([]int{1}, []int{1}) {
		t.Error("slices cannot be compared, so they are never the same")
	}
	p := &struct{ a int }{}
	if !same(p, p) {
		t.Error("pointers")
	}
}
