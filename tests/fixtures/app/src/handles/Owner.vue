<template>
  <div>
    <p class="owner">{{ acct.Label() }}</p>
    <Teller :acct="acct" :all="All()" :pair="Pair()" :check="Mine" />
    <button class="owner-deposit" @click="acct.Deposit(1)">+1</button>
    <button class="refresh" @click="Refresh">refresh</button>
  </div>
</template>

<script setup lang="go">
import (
	"syscall/js"

	"example.com/fixture/src/handles/bank"
)

//goesm:import "./Teller.vue"
var Teller js.Value

// A pointer passed to a child component as a prop, also in a slice and in
// a struct, is the same Go object there.
acct := bank.New("親", 10, nil)

func All() []*bank.Account { return []*bank.Account{acct} }

func Pair() bank.Pair { return bank.Pair{Left: acct} }

func Mine(a *bank.Account) bool { return a == acct }

// Refresh reads the bindings again, as any call of a Go function does.
func Refresh() {}
</script>
