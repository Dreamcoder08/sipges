// Command sipgesctl is the SIPGES command line: a client of the running API, for people and for
// agents proving behaviour. It is not ./sipges (deploy/local), which runs the installation.
package main

import (
	"context"
	"os"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/cli"
)

func main() {
	ctx, stop := cli.NotifyContext(context.Background())
	code := cli.Run(ctx, os.Args[1:], cli.IO{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Env: os.Getenv})
	stop()
	os.Exit(code)
}
