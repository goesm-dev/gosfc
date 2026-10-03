import { createApp, h } from "vue";
import Summary from "./src/Summary.vue";
import Counter from "./src/Counter.vue";
import Hello from "./src/Hello.vue";

createApp({ render: () => [h(Summary), h(Counter), h(Hello)] }).mount("#app");
