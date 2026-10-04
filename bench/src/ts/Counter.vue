<template>
  <span>{{ total }}</span>
  <button @click="Increment">Add</button>
</template>

<script setup lang="ts">
import { ref } from "vue";

const total = ref(0);

function Increment() {
  total.value++;
}
</script>
