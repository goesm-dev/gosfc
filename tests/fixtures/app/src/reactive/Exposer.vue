<template>
  <div class="exposer">
    <span ref="box" class="exp-count">{{ count }}</span>
    <span class="exp-pre">{{ pre }}</span>
    <span class="exp-sync">{{ sync }}</span>
    <span class="exp-post">{{ post }}</span>
    <span class="exp-el">{{ elTag }}</span>
  </div>
</template>

<script setup lang="go">
import (
	"syscall/js"

	"github.com/goesm-dev/gosfc/vue"
)

// What the parent reaches through its template ref (vue.Expose).
count := vue.NewRef(0)
vue.Expose("count", count)
vue.Expose("Add", func(n int) {
	for i := 0; i < n; i++ {
		count.Set(count.Get() + 1)
	}
})
vue.Expose("label", "exposer")

box := vue.NewRef(js.Null())

// pre runs once for the Sets of one tick, sync once per Set, and post after
// Vue updated the page.
pre := vue.NewRef(0)
vue.Watch(func() string { return string(rune('0' + count.Get())) }, func(string) { pre.Set(pre.Get() + 1) })
sync := vue.NewRef(0)
vue.Watch(func() string { return string(rune('0' + count.Get())) }, func(string) { sync.Set(sync.Get() + 1) }, vue.Flush("sync"))
post := vue.NewRef("")
vue.Watch(func() string { return string(rune('0' + count.Get())) }, func(string) { post.Set(box.Get().Get("textContent").String()) }, vue.Flush("post"))

// A js.Value is a watch source: Watch compares it with Equal.
elTag := vue.NewRef("")
vue.Watch(func() js.Value { return box.Get() }, func(el js.Value) {
	if el.Truthy() {
		elTag.Set(el.Get("tagName").String())
	}
})
</script>
