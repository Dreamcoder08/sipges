# SIPGES on your own computer (Windows and Linux)

Español: [README.es.md](README.es.md)

**Run SIPGES from your own fork, with your data on your own disk, opened like any desktop app.**
No paid account is needed. Nothing leaves the computer.

## How the sovereignty works

| What | Where it lives | Who controls it |
| --- | --- | --- |
| The code | Your fork on your own GitHub account, cloned to this computer | You |
| The data (database, uploaded files) | The state folder, in your user profile | You |
| The secrets (data key, admin password) | Two files in the state folder, readable only by your user | You |
| The server | A process on this computer, listening on `127.0.0.1:8000` only | You |

| System | State folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SIPGES` |
| Linux | `~/.local/share/sipges-local` |

Cloudflare and Neon are only needed to **publish** SIPGES online; this setup does not use them.
Local AI is optional: see [Optional: local AI](#optional-local-ai).

## Install (once)

You need [Git](https://git-scm.com/) and Node.js 24 or later. On Linux also `curl` and `openssl`
(preinstalled on most distributions). The installer adds pnpm 12.11.2 through npm. If that fails, run `npm install -g pnpm@12.11.2` in a new terminal and try again.

| Step | Windows | Linux |
| --- | --- | --- |
| 1. Fork the repository on GitHub, then clone your fork | `git clone <your fork URL>` | `git clone <your fork URL>` |
| 2. Install Node.js 24+, then **open a new terminal** so it is found | `winget install OpenJS.NodeJS.LTS` | Your package manager, or [nodejs.org](https://nodejs.org/) |
| 3. Run the installer from the clone | `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1` | `deploy/desktop/linux/install.sh` |

The installer installs the dependencies, builds the web app, creates the state folder and adds
**SIPGES** to the Start menu and Desktop (Windows) or to the application launcher (Linux).
It prints where the admin password is.

## Daily use

Open **SIPGES** from the menu. The first start takes up to a minute; the next ones are quick.

1. Sign in as `admin` with the password in `admin-password` (state folder).
2. SIPGES asks you to set up an authenticator app on the first sign-in. MFA stays on.

Closing the window leaves the server running, so the next open is instant. Signing out of the
computer or restarting stops it.

If the window does not open, read `api.log` in the state folder. New runs are appended to it.

## Update

```sh
git pull
```

Then run the installer again. It keeps your data, key and password.

## Back up and restore

The state folder is everything: the database is useless without `data-key`.

1. Stop the server so no file is half-written: restart the computer, or end the `node` process
   (Task Manager on Windows; `pkill -f apps/api/src/main.ts` on Linux).
2. Copy the whole state folder to an external disk or encrypted storage you control.
3. To restore, put the copy back in the same place (same user, same path) and open SIPGES.

Anyone who gets the folder gets your data and the key to read it. Keep copies private.

## Optional: local AI

Semantic search uses a local [Ollama](https://ollama.com/) server and stays on your computer.
Install Ollama, run `ollama pull nomic-embed-text`, then set the user environment variables
`SIPGES_OLLAMA_URL=http://127.0.0.1:11434` and `SIPGES_SEMANTIC_SEARCH=1` and restart the server.
Variable details: [docs/deployment/local-install.md](../../docs/deployment/local-install.md).

## Change the icon

`sipges.svg` is the source. Regenerate the other two files from `deploy/desktop` (needs
`rsvg-convert` and ImageMagick's `magick`; run it with `bash`):

```sh
tmp=$(mktemp -d)
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w $size -h $size sipges.svg -o "$tmp/$size.png"
done
magick "$tmp"/{16,24,32,48,64,128,256}.png sipges.ico
rsvg-convert -w 512 -h 512 sipges.svg -o sipges.png
rm -r "$tmp"
```

## Limits to know

- **Windows was not tested on a real Windows machine by this change.** The scripts follow
  Windows PowerShell 5.1 and standard Windows tools, and are checked statically only. If
  something fails, `api.log` and the message box are the first clues.
- Windows opens Microsoft Edge in app mode (always installed). Linux opens the first of Chrome,
  Chromium, Edge or Brave it finds, otherwise your default browser (a normal tab, no app window).
- The port is fixed at 8000. If another program uses it, SIPGES cannot start.
- A console window may flash for a moment when the Windows shortcut starts.
