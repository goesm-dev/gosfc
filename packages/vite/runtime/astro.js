// Frontmatter bindings for an .astro file whose frontmatter is Go (---go).
//
// The frontmatter runs once per render, so the Go block does too: runGo calls
// the lowered setup function (GosfcSetup) with the component's props when the
// block declares `type Props struct {...}`, waits for it when the block
// blocks (a blocking setup returns a Promise; Astro's frontmatter allows
// top-level await), and returns a function that reads one binding converted
// for the template (conversions: convert.js; Go objects: handles.js). Astro renders a template once,
// so there is no reactivity: a Go function called from the template returns
// its result and that is all.

import { readProps } from "gosfc:convert.js";
import { toTemplate } from "gosfc:handles.js";

/**
 * @param {(props?: any) => any} setup
 * @param {(() => Record<string, unknown>) | null} props zero value of the block's Props
 * @param {Record<string, unknown>} astroProps Astro.props
 * @param {Record<string, string>} [defaults] the `default` tags of the Props fields
 * @param {object} [astro] Astro's global, when the block reads Astro (the
 *   setup function's last parameter)
 * @returns {Promise<(name: string) => any>}
 */
export async function runGo(setup, props, astroProps, defaults, astro) {
  const lookup = await (props ? setup(readProps(props(), astroProps ?? {}, defaults), astro) : setup(astro));
  return (name) => toTemplate(lookup(name));
}
