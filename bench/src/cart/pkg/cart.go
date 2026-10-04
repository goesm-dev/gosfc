package cart

type Item struct {
	Price    int
	Quantity int
}

// Items returns n items with small, deterministic prices and quantities.
func Items(n int) []Item {
	items := make([]Item, n)
	for i := range items {
		items[i] = Item{Price: i%100 + 1, Quantity: i%3 + 1}
	}
	return items
}

func Total(items []Item) int {
	total := 0
	for _, item := range items {
		total += item.Price * item.Quantity
	}
	return total
}
