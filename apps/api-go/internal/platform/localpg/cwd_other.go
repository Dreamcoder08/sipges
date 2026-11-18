//go:build !linux

package localpg

// processInDir is unknown where the system does not expose a process's working folder.
func processInDir(int, string) (known, in bool) { return false, false }
