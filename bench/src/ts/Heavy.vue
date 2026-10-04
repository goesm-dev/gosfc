<template>
  <div>Total: {{ total }}</div>
</template>

<script setup lang="ts">
import { Items, Total } from "./cart";

const total = Total(Items(1000000));
</script>
