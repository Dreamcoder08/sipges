package desktopupdate

// File compatibility with the Node updater (deploy/desktop/updater/updater.mjs): an install that
// Node left half-updated recovers in Go, and what Go leaves behind recovers in Node. The Node
// functions run in a child process on synthetic scratch installs; skipped without node.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const nodeDriver = `import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
const [base, op, ...args] = process.argv.slice(2);
const { createRelease } = await import(new URL('release.mjs', base));
const u = await import(new URL('updater.mjs', base));
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
async function key(work) {
  const path = join(work, 'node-key.pem');
  try { return createPrivateKey(await readFile(path)); } catch {}
  const pair = generateKeyPairSync('ed25519');
  await writeFile(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return pair.privateKey;
}
async function release(work, version) {
  const pkg = join(work, 'node-package-' + version);
  await mkdir(join(pkg, 'web'), { recursive: true });
  await writeFile(join(pkg, 'metadata.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch }));
  await writeFile(join(pkg, 'start.mjs'), '// synthetic ' + version + '\n');
  await writeFile(join(pkg, 'web', 'index.html'), '<title>' + version + '</title>\n');
  const dir = join(work, 'node-release-' + version);
  await createRelease({ packageDir: pkg, releaseDir: dir, privateKey: await key(work) });
  return dir;
}
const write = (stateDir) => writeFile(join(stateDir, 'pglite', 'migrated'), 'synthetic');
try {
  if (op === 'install') {
    const [root, stateDir, work] = args;
    const rel = await release(work, '1.0.0');
    const pem = (await key(work));
    const { createPublicKey } = await import('node:crypto');
    out(await u.install({ root, release: rel, stateDir, trustKey: createPublicKey(pem).export({ type: 'spki', format: 'pem' }) }));
  } else if (op === 'release') {
    out({ release: await release(args[0], args[1]) });
  } else if (op === 'crash-update') {
    const [root, rel, step] = args;
    await u.update({ root, release: rel, migrate: async ({ stateDir }) => write(stateDir), ready: async () => {},
      onStep: (s) => { if (s === step) process.exit(70); } });
    out({ done: true });
  } else if (op === 'crash-first-start') {
    let calls = 0;
    await u.firstStart({ root: args[0], migrate: async ({ stateDir }) => {
      calls += 1;
      await write(stateDir);
      if (calls === 2) process.exit(70);
    } });
  } else if (op === 'first-start') {
    out(await u.firstStart({ root: args[0], migrate: async () => {} }));
  } else if (op === 'recover') {
    out(await u.recover({ root: args[0] }));
  } else if (op === 'inspect') {
    out(await u.inspectInstall(args[0]));
  } else if (op === 'hold') {
    const [root, rel, entered, gate] = args;
    out(await u.update({ root, release: rel, ready: async () => {}, migrate: async () => {
      await writeFile(entered, String(process.pid));
      for (;;) { try { await access(gate); break; } catch { await sleep(20); } }
    } }));
  }
} catch (error) {
  out({ error: error.code ?? null, message: error.message });
}
`

type nodeRunner struct {
	t      *testing.T
	script string
	base   string
}

func newNode(t *testing.T) *nodeRunner {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	updater, err := filepath.Abs("../../../../../deploy/desktop/updater")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(updater, "updater.mjs")); err != nil {
		t.Skip("the Node updater is not in this checkout")
	}
	script := filepath.Join(t.TempDir(), "driver.mjs")
	put(t, script, nodeDriver, 0)
	base := (&url.URL{Scheme: "file", Path: filepath.ToSlash(updater) + "/"}).String()
	return &nodeRunner{t: t, script: script, base: base}
}

func (n *nodeRunner) command(op string, args ...string) *exec.Cmd {
	return exec.Command("node", append([]string{n.script, n.base, op}, args...)...)
}

// run returns the last JSON line the driver printed and its exit status.
func (n *nodeRunner) run(op string, args ...string) (map[string]any, int) {
	n.t.Helper()
	cmd := n.command(op, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	status := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			n.t.Fatalf("node %s: %v", op, err)
		}
		status = exit.ExitCode()
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var value map[string]any
	if last := lines[len(lines)-1]; last != "" {
		if err := json.Unmarshal([]byte(last), &value); err != nil {
			n.t.Fatalf("node %s printed %q (%s)", op, out, stderr.String())
		}
	}
	return value, status
}

// nodeInstall installs 1.0.0 with the Node updater over a synthetic state folder.
func nodeInstall(t *testing.T, n *nodeRunner, dir string) (root, state string) {
	t.Helper()
	root, state = filepath.Join(dir, "install"), filepath.Join(dir, "state")
	makeState(t, state)
	if got, _ := n.run("install", root, state, dir); got["version"] != "1.0.0" {
		t.Fatalf("node install: %v", got)
	}
	return root, state
}

func (n *nodeRunner) release(dir, version string) string {
	n.t.Helper()
	got, _ := n.run("release", dir, version)
	path, ok := got["release"].(string)
	if !ok {
		n.t.Fatalf("node release: %v", got)
	}
	return path
}

func TestCompatNodeCrashedUpdatesRecoverInGo(t *testing.T) {
	n := newNode(t)
	for _, step := range []string{"state-copied", "migrated", "switched", "ready"} {
		t.Run(step, func(t *testing.T) {
			dir := t.TempDir()
			root, state := nodeInstall(t, n, dir)
			before := snapshot(t, state)
			if _, status := n.run("crash-update", root, n.release(dir, "1.1.0"), step); status != 70 {
				t.Fatalf("node did not crash at %s: %d", step, status)
			}
			if !exists(t, filepath.Join(root, "update-journal.json")) || !exists(t, filepath.Join(root, "update.lock")) {
				t.Fatal("node left no journal or lock")
			}
			got, err := Recover(context.Background(), root)
			if err != nil || !got.Recovered || got.Current.Version != "1.0.0" {
				t.Fatalf("go recover: %v %+v", err, got)
			}
			assertSnapshot(t, snapshot(t, state), before, "state restored")
			inspected, err := InspectInstall(root)
			if err != nil || !inspected.Complete {
				t.Fatalf("inspect: %v %+v", err, inspected)
			}
			if lines := lockFiles(t, root); len(lines) != 0 {
				t.Fatalf("lock left %v", lines)
			}
			// Go then updates the Node install from a Node-signed release.
			done, err := Update(context.Background(), UpdateOptions{
				Root: root, Release: n.release(dir, "1.2.0"), Verifier: &fakeVerifier{}, Migrate: noop, Ready: noop,
			})
			if err != nil || done.From != "1.0.0" || done.To != "1.2.0" {
				t.Fatalf("go update: %v %+v", err, done)
			}
			if got, _ := n.run("inspect", root); got["complete"] != true || got["version"] != "1.2.0" {
				t.Fatalf("node inspects the Go update: %v", got)
			}
		})
	}
}

func TestCompatNodeCrashedFirstStartRecoversInGoAndNodeMarkerIsRespected(t *testing.T) {
	n := newNode(t)
	dir := t.TempDir()
	root, state := nodeInstall(t, n, dir)
	before := snapshot(t, state)
	if _, status := n.run("crash-first-start", root); status != 70 {
		t.Fatalf("node did not crash: %d", status)
	}
	var journal map[string]any
	if err := json.Unmarshal([]byte(readText(t, filepath.Join(root, "update-journal.json"))), &journal); err != nil {
		t.Fatal(err)
	}
	if journal["kind"] != "first-start" || journal["phase"] != "migrating" {
		t.Fatalf("journal %v", journal)
	}
	got, err := Recover(context.Background(), root)
	if err != nil || !got.Recovered {
		t.Fatalf("go recover: %v %+v", err, got)
	}
	assertSnapshot(t, snapshot(t, state), before, "state restored")
	if got, _ := n.run("first-start", root); got["done"] != true {
		t.Fatalf("node first start: %v", got)
	}
	result, err := FirstStart(context.Background(), FirstStartOptions{Root: root, Migrate: noop})
	if err != nil || result.Done {
		t.Fatalf("go reads the Node marker: %v %+v", err, result)
	}
}

func TestCompatGoCrashedUpdateRecoversInNode(t *testing.T) {
	n := newNode(t)
	for _, step := range []string{"state-copied", "migrated", "switched"} {
		t.Run(step, func(t *testing.T) {
			f := newFixture(t, t.TempDir())
			before := snapshot(t, f.state)
			crashAt(t, f.root, f.release("1.1.0"), step)
			got, status := n.run("recover", f.root)
			if status != 0 || got["recovered"] != true || got["version"] != "1.0.0" {
				t.Fatalf("node recover: %d %v", status, got)
			}
			assertSnapshot(t, snapshot(t, f.state), before, "state restored by node")
			if got, _ := n.run("inspect", f.root); got["complete"] != true {
				t.Fatalf("node inspects the Go install: %v", got)
			}
		})
	}
}

func TestCompatGoFirstStartMarkerIsRespectedByNode(t *testing.T) {
	n := newNode(t)
	f := firstStartFixture(t, t.TempDir(), true)
	if _, err := runFirstStart(f.root, noop, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := n.run("first-start", f.root); got["done"] != false || got["version"] != "1.0.0" {
		t.Fatalf("node first start: %v", got)
	}
}

func TestCompatNodeAndGoNeverHoldTheLockTogether(t *testing.T) {
	n := newNode(t)
	dir := t.TempDir()
	root, _ := nodeInstall(t, n, dir)
	entered, gate := filepath.Join(dir, "entered"), filepath.Join(dir, "gate")
	cmd := n.command("hold", root, n.release(dir, "1.1.0"), entered, gate)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, entered)
	_, err := Recover(context.Background(), root)
	e := wantCode(t, err, CodeBusy, "node holds the lock")
	if !strings.Contains(e.Message, fmt.Sprint(cmd.Process.Pid)) {
		t.Fatalf("message %q", e.Message)
	}
	put(t, gate, "", 0)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}

	// And the other way round: Go holds it, Node is BUSY.
	release := n.release(dir, "1.2.0")
	goEntered, goGate := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := Update(context.Background(), UpdateOptions{
			Root: root, Release: release, Verifier: &fakeVerifier{}, Ready: noop,
			Migrate: func(context.Context, Target) error { close(goEntered); <-goGate; return nil },
		})
		done <- err
	}()
	<-goEntered
	got, _ := n.run("recover", root)
	if got["error"] != "BUSY" || !strings.Contains(fmt.Sprint(got["message"]), fmt.Sprint(os.Getpid())) {
		t.Fatalf("node while Go holds the lock: %v", got)
	}
	close(goGate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if lines := lockFiles(t, root); len(lines) != 0 {
		t.Fatalf("lock left %v", lines)
	}
}

func waitFor(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !exists(t, path) {
		if time.Now().After(deadline) {
			t.Fatalf("%s never appeared", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
