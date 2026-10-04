<template>
  <p class="greet">{{ message }}</p>
</template>

<script setup lang="go">
import "strings"

type Props struct {
	Name     string
	Times    int
	Loud     bool
	HTMLNote string
}

message := strings.Repeat("hi "+props.Name+" ", props.Times) + props.HTMLNote
if props.Loud {
	message = strings.ToUpper(message)
}
</script>
