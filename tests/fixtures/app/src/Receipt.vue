<template>
  <p>{{ Line({ Price: 120, Quantity: 3 }) }} / {{ Sum([{ Price: 100, Quantity: 2 }, { Price: 50 }]) }}</p>
</template>

<script setup lang="go">
import (
	"strconv"

	cart "example.com/fixture/src/cart/pkg"
)

func Line(item cart.Item) string {
	return strconv.Itoa(item.Quantity) + " × " + strconv.Itoa(item.Price)
}

func Sum(items []cart.Item) int {
	return cart.Total(items)
}
</script>
