<template>
  <div>
    <p class="teller-same">{{ Same() }}</p>
    <p class="teller">{{ props.Acct.Label() }}</p>
    <button class="teller-deposit" @click="Deposit">+5</button>
  </div>
</template>

<script setup lang="go">
import "example.com/fixture/src/handles/bank"

type Props struct {
	Acct  *bank.Account
	All   []*bank.Account
	Pair  bank.Pair
	Check func(*bank.Account) bool
}

// Same reports, for the prop itself, the slice and the struct, whether the
// pointer is the parent's.
func Same() string {
	return yes(props.Check(props.Acct)) + yes(props.All[0] == props.Acct) + yes(props.Pair.Left == props.Acct)
}

func yes(b bool) string {
	if b {
		return "y"
	}
	return "n"
}

// Deposit changes the parent's account.
func Deposit() { props.Acct.Deposit(5) }
</script>
