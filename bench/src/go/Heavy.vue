<template>
  <div>Total: {{ total }}</div>
</template>

<script setup lang="go">
import cart "example.com/bench/src/cart/pkg"

total := cart.Total(cart.Items(1000000))
</script>
