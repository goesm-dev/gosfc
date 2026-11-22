import { createApp } from "vue";
import Accounts from "./src/handles/Accounts.vue";
import Owner from "./src/handles/Owner.vue";

createApp(Accounts).mount("#app");
createApp(Owner).mount("#owner");
