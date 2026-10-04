<template>
  <span>{{ total }}</span>
  <button @click="Increment">Add</button>
</template>

<script setup lang="go">
total := 0

func Increment() {
	total++
}
</script>
