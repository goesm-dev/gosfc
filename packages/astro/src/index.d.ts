// The types of @gosfc/astro (src/index.js).

import type { AstroIntegration } from "astro";

export interface GosfcAstroOptions {
  /**
   * The options passed to @astrojs/vue when gosfc adds it, or false not to
   * add it.
   */
  vue?: false | NonNullable<Parameters<typeof import("@astrojs/vue").default>[0]>;
}

/** The Astro integration of gosfc: @gosfc/vite, plus @astrojs/vue when the project uses Vue. */
export default function gosfc(options?: GosfcAstroOptions): AstroIntegration;

/**
 * Whether a JavaScript or TypeScript file under the source directory src runs
 * on the server only: an endpoint, the middleware or an action.
 */
export function serverOnly(src: string, file: string): boolean;
