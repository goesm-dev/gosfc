export interface Item {
  Price: number;
  Quantity: number;
}

// Items returns n items with small, deterministic prices and quantities.
export function Items(n: number): Item[] {
  const items: Item[] = new Array(n);
  for (let i = 0; i < n; i++) {
    items[i] = { Price: (i % 100) + 1, Quantity: (i % 3) + 1 };
  }
  return items;
}

export function Total(items: Item[]): number {
  let total = 0;
  for (const item of items) {
    total += item.Price * item.Quantity;
  }
  return total;
}
