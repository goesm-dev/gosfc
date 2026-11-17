// A named export a Go frontmatter imports with //goesm:import.
export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
