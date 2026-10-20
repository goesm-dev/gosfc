// Package lib is imported from the page's TypeScript with go:.
package lib

import "strconv"

// Yen formats an amount of yen.
func Yen(n int) string {
	return "¥" + strconv.Itoa(n)
}
