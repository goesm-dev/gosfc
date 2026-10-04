// Renders the benchmark results as an SVG bar chart for the README: one
// panel per metric, gosfc and Vue side by side. Metrics have different units,
// so each panel has its own scale, starting at zero.

const themes = {
  light: { go: "#2a78d6", ts: "#eb6834", text: "#1f2328", muted: "#59636e", grid: "#d1d9e0" },
  dark: { go: "#3987e5", ts: "#d95926", text: "#f0f6fc", muted: "#9198a1", grid: "#3d444d" },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A bar anchored at x on the left, with its data end (right) rounded. */
function bar(x, y, w, h, fill) {
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z" fill="${fill}"/>`;
}

/**
 * @param {{ label: string, go: number, ts: number, format: (v: number) => string }[]} metrics
 * @param {"light" | "dark"} theme
 * @param {{ go: string, ts: string }} names series names for the legend
 */
export function renderChart(metrics, theme, names) {
  const c = themes[theme];
  const width = 720;
  const labelW = 200;
  const valueW = 80;
  const plotW = width - labelW - valueW;
  const barH = 14;
  const gap = 2;
  const panelH = 2 * barH + gap + 22;
  const top = 44;
  const height = top + metrics.length * panelH + 4;
  const font = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${font} role="img" aria-labelledby="t">`);
  out.push(`<title id="t">${esc(metrics.map((m) => `${m.label}: ${names.go} ${m.format(m.go)}, ${names.ts} ${m.format(m.ts)}`).join("; "))}</title>`);

  // Legend.
  let lx = 0;
  for (const [key, name] of [["go", names.go], ["ts", names.ts]]) {
    out.push(`<rect x="${lx}" y="6" width="12" height="12" rx="3" fill="${c[key]}"/>`);
    out.push(`<text x="${lx + 18}" y="16" font-size="13" fill="${c.text}">${esc(name)}</text>`);
    lx += 18 + name.length * 7.5 + 24;
  }
  out.push(`<text x="${width}" y="16" font-size="12" fill="${c.muted}" text-anchor="end">Shorter is better · each panel has its own scale from 0</text>`);

  metrics.forEach((m, i) => {
    const y = top + i * panelH;
    const max = Math.max(m.go, m.ts);
    out.push(`<line x1="${labelW}" y1="${y - 4}" x2="${labelW}" y2="${y + 2 * barH + gap + 4}" stroke="${c.grid}" stroke-width="1"/>`);
    out.push(`<text x="0" y="${y + barH - 1}" font-size="13" fill="${c.text}">${esc(m.label)}</text>`);
    out.push(`<text x="0" y="${y + 2 * barH + gap - 1}" font-size="12" fill="${c.muted}">gosfc / Vue: ${(m.go / m.ts).toFixed(2)}x</text>`);
    ["go", "ts"].forEach((key, j) => {
      const by = y + j * (barH + gap);
      const w = Math.max(1, (m[key] / max) * plotW);
      out.push(bar(labelW, by, w, barH, c[key]));
      out.push(`<text x="${labelW + w + 6}" y="${by + barH - 3}" font-size="12" fill="${c.text}">${esc(m.format(m[key]))}</text>`);
    });
  });

  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
