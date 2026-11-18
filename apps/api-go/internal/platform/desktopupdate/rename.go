package desktopupdate

import (
	"os"
	"runtime"
	"time"
)

// Windows refuses a rename while another process holds the file or folder (an antivirus scan,
// the search indexer, an open Explorer window), sometimes for many seconds. Such a refusal is
// retried with pauses growing from renameFirstWait to renameMaxWait until renameBudget has passed
// since the first attempt; then the last error is returned unchanged.
const (
	renameBudget    = 45 * time.Second
	renameFirstWait = 100 * time.Millisecond
	renameMaxWait   = 2 * time.Second
)

type renameOptions struct {
	move    func(from, to string) error
	wait    func(time.Duration)
	now     func() time.Time
	windows bool
}

// RenameRetry renames like os.Rename, waiting out a transient hold on Windows.
func RenameRetry(from, to string) error {
	return renameRetry(from, to, renameOptions{
		move: os.Rename, wait: time.Sleep, now: time.Now, windows: runtime.GOOS == "windows",
	})
}

func renameRetry(from, to string, o renameOptions) error {
	deadline := o.now().Add(renameBudget)
	for pause := renameFirstWait; ; pause = min(pause*2, renameMaxWait) {
		err := o.move(from, to)
		if err == nil {
			return nil
		}
		left := deadline.Sub(o.now())
		if !o.windows || !renameHeld(err) || left <= 0 {
			return err
		}
		o.wait(min(pause, left))
	}
}
