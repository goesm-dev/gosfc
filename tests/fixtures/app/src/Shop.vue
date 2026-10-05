<template>
  <p>{{ price }} <Badge :label="tag" /> {{ formatPrice(500) }}</p>
</template>

<script setup lang="go">
import "syscall/js"

//goesm:import "./Badge.vue"
var Badge js.Value

//goesm:import "./format.ts" formatPrice
func formatPrice(yen int) string

price := formatPrice(12800)
tag := "新着"
</script>
