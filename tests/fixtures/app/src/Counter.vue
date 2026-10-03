<template>
  <div class="counter">
    <span class="count">{{ total }}</span>
    <button @click="Increment">Add</button>
  </div>
</template>

<script setup lang="go">
total := 0

func Increment() {
	total++
}
</script>

<style scoped>
.count {
  font-weight: bold;
}
</style>
