// Command gosfc is the Go side of gosfc.
//
//	gosfc synth < input.json > output.json
//
// synth reads one <script setup lang="go"> block (synth.Input as JSON) and
// writes the synthetic Go file and its template bindings (synth.Output as
// JSON). The Vite plugin runs it with `go tool gosfc`, so the version is the
// one pinned in the application's go.mod. It never compiles Go; goesm does.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/goesm-dev/gosfc/internal/synth"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "synth" {
		fmt.Fprintln(os.Stderr, "usage: gosfc synth < input.json")
		os.Exit(2)
	}
	var in synth.Input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "gosfc synth:", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(synth.Build(in)); err != nil {
		fmt.Fprintln(os.Stderr, "gosfc synth:", err)
		os.Exit(1)
	}
}
