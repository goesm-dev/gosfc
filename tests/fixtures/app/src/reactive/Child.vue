<template>
  <div class="child">
    <span class="label">{{ props.Label }}</span>
    <span class="size">{{ props.Size }}</span>
    <span class="note">{{ props["display-note"] }}</span>
    <span class="seen">{{ seen }}</span>
    <span class="shared">{{ ticks }}</span>
    <button @click="Pick">pick</button>
  </div>
</template>

<script setup lang="go">
import (
	"example.com/fixture/src/reactive/clock"
	"github.com/goesm-dev/gosfc/vue"
)

type Props struct {
	Label string
	Count int
	Size  int `default:"20"`
	// A hyphenated key: Vue declares the prop as displayNote.
	Note string `json:"display-note"`
}

emit := vue.Emitter()

// ticks is the Ref of package clock that the parent binds too: one program
// lowers clock once, so both components see the same Ref.
ticks := clock.Ticks

// seen counts the changes of the count prop the watcher noticed.
seen := vue.NewRef(0)
vue.Watch(func() int { return props.Count }, func(int) { seen.Set(seen.Get() + 1) })

func Pick() {
	emit("picked", props.Label, props.Count)
}
</script>
