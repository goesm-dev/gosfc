// A plain JS module importing a Go package directly.
import { Item, Total, $runtime as rt } from "go:example.com/fixture/src/cart/pkg";

export function total(items) {
  return Total(rt.sliceLit(items.map(([price, quantity]) => new Item(price, quantity))));
}
