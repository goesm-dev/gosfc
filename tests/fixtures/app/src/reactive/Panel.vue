<template>
  <div>
    <p class="ticks">{{ ticks }}</p>
    <p class="doubled">{{ doubled }}</p>
    <p class="parity">{{ Parity() }}</p>
    <input v-model="name" class="name" />
    <p class="greeting">{{ Greeting() }}</p>
    <canvas ref="canvas" width="10" height="10"></canvas>
    <p class="canvas">{{ canvasTag }}</p>
    <Child class="first" :label="name" :count="ticks" @picked="Picked" />
    <Child label="defaults" display-note="noted" />
    <p class="picked">{{ picked }}</p>
    <p class="mounted">{{ mounted }}</p>
    <p class="watched">{{ watched }}</p>
    <p class="steady">{{ steady }}</p>
    <p class="slow">{{ slow }}</p>
    <p class="slowest">{{ slowest }}</p>
    <button class="bump" @click="bump">{{ clicks }}</button>
  </div>
</template>

<script setup lang="go">
import (
	"strings"
	"syscall/js"
	"time"

	"example.com/fixture/src/reactive/clock"
	"github.com/goesm-dev/gosfc/vue"
)

//goesm:import "./Child.vue"
var Child js.Value

ticks := clock.Ticks
doubled := vue.NewComputed(func() int { return ticks.Get() * 2 })
name := vue.NewRef("gopher")
canvas := vue.NewRef(js.Null())
canvasTag := vue.NewRef("")
picked := vue.NewRef("")
mounted := vue.NewRef(false)
watched := vue.NewRef(0)

// clicks is a plain variable; bump, a function in a Ref, changes it.
clicks := 0
bump := vue.NewRef(func() { clicks++ })

func Parity() string {
	if ticks.Get()%2 == 0 {
		return "even"
	}
	return "odd"
}

func Greeting() string { return "Hello, " + strings.ToUpper(name.Get()) }

func Picked(label string, n int) {
	picked.Set(label + ":" + strings.Repeat("!", n))
}

vue.Watch(func() int { return ticks.Get() }, func(n int) { watched.Set(watched.Get() + 1) })

// steady counts the calls of a watcher whose value never changes, though
// the Ref it reads does: there must be none.
steady := vue.NewRef(0)
vue.Watch(func() bool { return ticks.Get() < 0 }, func(bool) { steady.Set(steady.Get() + 1) })

// slow counts the changes a watcher whose src blocks noticed. Such a src
// makes goesm turn every watcher's getter async.
slow := vue.NewRef(0)
vue.Watch(func() int {
	n := ticks.Get()
	time.Sleep(time.Millisecond)
	return n
}, func(int) { slow.Set(slow.Get() + 1) })

// slowest is the last value seen by a watcher whose src blocks longer
// than the ticks are apart: its getters overlap, and the newest value
// still arrives.
slowest := vue.NewRef(0)
vue.Watch(func() int {
	n := ticks.Get()
	time.Sleep(60 * time.Millisecond)
	return n
}, func(n int) { slowest.Set(n) })

vue.OnMounted(func() {
	mounted.Set(true)
	canvasTag.Set(canvas.Get().Get("tagName").String())
	clock.Start(20*time.Millisecond, 3)
})
</script>
