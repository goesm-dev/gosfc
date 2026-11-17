<template>
  <div>
    <p class="fields">{{ acct.owner }} {{ acct.balance }} {{ acct.tags.length }} {{ acct.parent.owner }}</p>
    <p class="method">{{ acct.Label() }}</p>
    <p class="call">{{ Main().owner }} {{ Main().parent }}</p>
    <p class="list">{{ All()[0].owner }},{{ All()[1].owner }}</p>
    <p class="same">{{ Same(acct) }}</p>
    <button class="deposit" @click="acct.Deposit(5)">+5</button>
    <button class="give" @click="Give(acct)">give</button>
    <p class="given">{{ given }}</p>
  </div>
</template>

<script setup lang="go">
import "example.com/fixture/src/handles/bank"

// Pointers to a struct type with methods reach the template as views of
// their fields and methods (runtime/handles.js).
main := bank.New("本店", 100, nil)
acct := bank.New("ゴー", 10, main)
given := ""

func Main() *bank.Account { return main }

func All() []*bank.Account { return []*bank.Account{main, acct} }

// A view passed back to Go is the Go object itself.
func Same(a *bank.Account) bool { return a == acct }

func Give(a *bank.Account) {
	given = a.Label()
	if a == acct {
		given += " (same)"
	}
}
</script>
