package infrastructure_test

import "runtime"

func isWindows() bool { return runtime.GOOS == "windows" }
