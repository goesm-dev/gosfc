<template>
  <div>
    <p class="ticks">{{ ticks }}</p>
    <p class="doubled">{{ doubled }}</p>
    <p class="parity">{{ Parity() }}</p>
    <input v-model="name" class="name" />
    <p class="greeting">{{ Greeting() }}</p>
    <canvas ref="canvas" width="10" height="10"></canvas>
    <p class="canvas">{{ canvasTag }}</p>
    <Child :label="name" :count="ticks" @picked="Picked" />
    <Child label="defaults" />
    <p class="picked">{{ picked }}</p>
    <p class="mounted">{{ mounted }}</p>
    <p class="watched">{{ watched }}</p>
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

vue.OnMounted(func() {
	mounted.Set(true)
	canvasTag.Set(canvas.Get().Get("tagName").String())
	clock.Start(20*time.Millisecond, 3)
})
</script>
