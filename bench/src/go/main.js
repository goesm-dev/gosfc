import { createApp, h } from "vue";
import Counter from "./Counter.vue";
import Summary from "./Summary.vue";

createApp({ render: () => [h(Summary), h(Counter)] }).mount("#app");
