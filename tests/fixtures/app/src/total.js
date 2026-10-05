// A plain JS module importing a Go package directly.
import { Total } from "go:example.com/fixture/src/cart/pkg";

export function total(items) {
  return Total(items.map(([price, quantity]) => ({ Price: price, Quantity: quantity })));
}
