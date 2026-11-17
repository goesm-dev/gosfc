<template>
  <button class="rating" @click="Rate">{{ props.Label }}: {{ stars }} ({{ props.Tags.length }}) {{ props["note-text"] }} #{{ props.itemId }}</button>
</template>

<script setup lang="go">
import (
	"strings"

	"github.com/goesm-dev/gosfc/vue"
)

// The props and events a TypeScript parent sees (vue-tsc with the Vue
// language plugin, tests/types.test.mjs).
type Props struct {
	Label string
	Max   int `default:"5"`
	Tags  []string
	Note  string `json:"note-text"`
	ID    int    `json:"id" js:"itemId"`
}

emit := vue.Emitter()
stars := strings.Repeat("*", props.Max)

func Rate() {
	emit("rated", props.Max, props.Note)
}
</script>
