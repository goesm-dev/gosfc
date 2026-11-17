// The types of @gosfc/vite (src/index.js).

import type { Plugin } from "vite";

export interface GosfcOptions {
  /**
   * Where to write the types of go: imports, relative to Vite's root
   * (gosfc.d.ts unless set), false for nowhere, or a function that returns
   * the file when it is written.
   */
  dts?: string | false | (() => string | undefined);
  /**
   * Whether a JavaScript or TypeScript file runs on the server only (such as
   * Astro's endpoints and middleware), so that the browser's program starts
   * without its go: imports.
   */
  serverOnly?: (file: string) => boolean;
}

/** Compiles <script setup lang="go"> in .vue files and Go in .astro files through goesm. */
export default function gosfc(options?: GosfcOptions): Plugin;

export interface GoModuleOutput {
  importPath: string;
  code: string;
  map: any;
  dts?: string;
}

export interface CompileResult {
  code: string;
  map: any;
  modules: GoModuleOutput[];
  runtime: { file: string; code: string }[];
  goFiles: string[];
}

/** Compiles one .vue file: null when it has no <script setup lang="go">. */
export function compileSfc(code: string, filename: string, opts: { root: string }): Promise<CompileResult | null>;

/** Compiles the Go of one .astro file: null when it has none. */
export function compileAstro(code: string, filename: string, opts: { root: string }): Promise<CompileResult | null>;

/** The content of the types file before any Go has been compiled. */
export const GO_TYPES_PLACEHOLDER: string;

/** The types of the go: imports and Go components of the app at root, from a scan of its files (null when there are none). */
export function scanGoImportTypes(root: string, outDirs?: string[]): Promise<string | null>;

/** Writes content to file unless it already holds it. */
export function writeTypes(file: string, content: string): void;

/** The prerender option a Go frontmatter declares with `const Prerender = true` (or false), or undefined. */
export function goPrerender(code: string): boolean | undefined;

