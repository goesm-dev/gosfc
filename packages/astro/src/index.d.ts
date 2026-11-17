// The types of @gosfc/astro (src/index.js).

import type { AstroIntegration } from "astro";

export interface GosfcAstroOptions {
  /**
   * The options passed to @astrojs/vue when gosfc adds it, or false not to
   * add it.
   */
  vue?: false | NonNullable<Parameters<typeof import("@astrojs/vue").default>[0]>;
  /**
   * Endpoints written in Go, by route pattern (`"/api/[id].json"`): the
   * import path of a Go package that exports GET, POST and the other
   * methods, or that and whether the route is prerendered.
   */
  routes?: Record<string, string | { package: string; prerender?: boolean }>;
  /**
   * Middleware written in Go: the import paths of Go packages that export
   * OnRequest, which run before the middleware of src/middleware.
   */
  middleware?: string | string[];
}

/** The Astro integration of gosfc: @gosfc/vite, plus @astrojs/vue when the project uses Vue. */
export default function gosfc(options?: GosfcAstroOptions): AstroIntegration;

/**
 * Whether a JavaScript or TypeScript file under the source directory src runs
 * on the server only: an endpoint, the middleware or an action.
 */
export function serverOnly(src: string, file: string): boolean;
