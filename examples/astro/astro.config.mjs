import { defineConfig } from "astro/config";
import gosfc from "@gosfc/astro";

export default defineConfig({
  integrations: [gosfc()],
  vite: {
    build: { sourcemap: true },
  },
});
