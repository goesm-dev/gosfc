<template>
  <div class="child">
    <span class="label">{{ props.Label }}</span>
    <span class="size">{{ props.Size }}</span>
    <span class="seen">{{ seen }}</span>
    <button @click="Pick">pick</button>
  </div>
</template>

<script setup lang="go">
import "github.com/goesm-dev/gosfc/vue"

type Props struct {
	Label string
	Count int
	Size  int `default:"20"`
}

emit := vue.Emitter()

// seen counts the changes of the count prop the watcher noticed.
seen := vue.NewRef(0)
vue.Watch(func() int { return props.Count }, func(int) { seen.Set(seen.Get() + 1) })

func Pick() {
	emit("picked", props.Label, props.Count)
}
</script>
