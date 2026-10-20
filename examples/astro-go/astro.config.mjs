import { defineConfig } from "astro/config";
import gosfc from "@gosfc/astro";

// Go in .astro files only: no Vue, no @astrojs/vue.
export default defineConfig({
  integrations: [gosfc()],
});
