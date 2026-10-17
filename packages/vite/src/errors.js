// Errors reported at a position of a .vue, .astro or .go file, in the shape
// Vite's error overlay and Astro understand.

import { generateCodeFrame } from "@vue/compiler-sfc";
import path from "node:path";

/**
 * @typedef {{ message: string, file: string, line: number, column: number, frame?: string }} SfcError
 */

export class GosfcError extends Error {
  /** @param {SfcError[]} errors @param {string} root */
  constructor(errors, root) {
    super(errors.map((e) => `${displayPath(e.file, root)}:${e.line}:${e.column}: ${e.message}`).join("\n"));
    this.name = "GosfcError";
    this.errors = errors;
    const first = errors[0];
    // Shape understood by Vite's error overlay and by Astro.
    this.id = first.file;
    this.loc = { file: first.file, line: first.line, column: first.column };
    this.frame = first.frame;
  }
}

/** @param {string} code @param {number} offset */
export function lineCol(code, offset) {
  const before = code.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

function offsetOf(code, line, column) {
  let off = 0;
  for (let l = 1; l < line; l++) off = code.indexOf("\n", off) + 1;
  return off + column - 1;
}

/** @param {SfcError} e @param {string} code */
export function withFrame(e, code) {
  const off = offsetOf(code, e.line, e.column);
  return { ...e, frame: generateCodeFrame(code, off, off + 1) };
}

export function sfcError(file, code, offset, message, root) {
  return new GosfcError([withFrame({ file, ...lineCol(code, offset), message }, code)], root);
}

function displayPath(file, root) {
  const rel = path.relative(root, file);
  return rel.startsWith("..") ? file : rel.split(path.sep).join("/");
}
