import { defineConfig } from "astro/config";
import gosfc from "@gosfc/astro";

// Go in .astro files only: no Vue, no @astrojs/vue. The endpoint and the
// middleware are Go packages too.
export default defineConfig({
  integrations: [
    gosfc({
      routes: { "/api/[id].json": "example.com/astrogo/src/api" },
      middleware: "example.com/astrogo/src/server",
    }),
  ],
});
