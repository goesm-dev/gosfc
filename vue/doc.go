// Package vue lets the Go of a gosfc component, and the Go packages it uses,
// take part in Vue's reactivity.
//
// A template re-renders when a Ref it read changes, whoever changes it: an
// event handler, a timer, a goroutine, another component.
//
//	count := vue.NewRef(0)          // {{ count }} in the template
//	go func() {
//		for range time.Tick(time.Second) {
//			count.Set(count.Get() + 1)
//		}
//	}()
//
// A Ref bound in a template reads as its value, and v-model and ref="..."
// write it. A Go function called from the template is re-run when a Ref it
// read changes. Computed, Watch and WatchEffect derive values and run side
// effects; OnMounted and the other hooks, and Emitter, need the component
// being set up, so call them from the top level of a <script setup lang="go">
// block.
//
// Outside a goesm build (go test, go vet), the package works without Vue:
// Refs and Computeds hold and compute their values, and watchers and hooks
// never run.
package vue
