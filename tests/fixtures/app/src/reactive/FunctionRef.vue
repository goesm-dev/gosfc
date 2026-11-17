<template>
  <div class="fref">
    <p :ref="(el) => SetEl(el)" class="fref-calls">{{ calls }}</p>
    <p class="fref-tags">{{ tags }}</p>
    <button class="fref-bump" @click="Bump">{{ clicks }}</button>
  </div>
</template>

<script setup lang="go">
import "syscall/js"

// calls counts the calls of the function ref. Vue makes them while it
// patches the page, after the render that shows calls.
calls := 0

// tags is a slice, which reaches the template as a new array whenever it is
// read again.
tags := []string{}
clicks := 0

func SetEl(el js.Value) {
	calls++
	if el.Truthy() {
		tags = []string{el.Get("tagName").String()}
	}
}

func Bump() { clicks++ }
</script>
