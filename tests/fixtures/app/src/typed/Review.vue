<template>
  <Rating label="Quality" :max="limit" :tags="tags" note-text="fine" :item-id="7" @rated="onRated" />
  <p class="last">{{ last }}</p>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Rating from "./Rating.vue";

const limit = ref(3);
const tags = ["fast", "quiet"];
const last = ref(0);

function onRated(stars: number, note: string) {
  last.value = stars + note.length;
}
</script>
