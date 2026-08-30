# The settings file, and what each kind of product needs

Two questions answered in one place, because they are really one question:

1. **What can I put in the settings file?** Every option, per kind of product.
2. **What has to be on this machine before that option can work?** Every program,
   every environment variable, every licence a person has to accept — with the
   exact command, not "you may need Xcode".

You should not have to read this. `staysfixed init` reads the repository and
writes the file for you, with an explanation beside every option, and
`staysfixed doctor` tells you what is missing and how to get it. This page is
here for when you want to add something `init` could not know, and for an agent
setting this up on somebody's machine that needs to be sure before it speaks.

---

## Where the file goes

The first of these that exists, searched from the folder you run in and then
upwards:

```
staysfixed.config.js
staysfixed.config.mjs
staysfixed.config.json
.staysfixed/config.js
.staysfixed/config.mjs
.staysfixed/config.json
```

`--config <file>` overrides all of it and names the project. JSON works
everywhere; JavaScript is only needed when a value has to be worked out at the
moment it is read.

The shape is one product name and one block per kind of thing your repository
makes:

```js
export default {
  product: 'your-app',
  source: { /* reading the code */ },
  process: { /* commands and libraries */ },
  http: { /* a server */ },
  web: { /* a website */ },
  electron: { /* a desktop app */ },
  android: { /* an APK */ },
  ios: { /* a simulator build */ },
  windows: { /* a native Windows program */ },
};
```

A repository that makes four things has four blocks. Leaving a block out is how
you say "there is none of that here" — it is never an error, and the run says
which kinds it did not check.

**Two things are not settings, and never will be.** There is no tolerance: how
much your product disagrees with itself is measured by running the new build
twice, and subtracted. And there is nothing to approve: the build you say
`staysfixed ship` about becomes what "working" means.

---


### `process.alsoWatch`

A list of extra folders a command is allowed to touch, so that what it writes there is
watched rather than counted as a surprise. The tool's own run output names this option, and
until 2026-08-30 it appeared nowhere here — in a page whose promise is every option, per kind
of product.

```js
process: {
  commands: [{ name: 'build', run: 'npm run build' }],
  alsoWatch: ['dist', '../shared/generated'],
}
```

## `product`

```js
product: 'your-app',
```

The name the record is kept under. One repository can build five things and each
keeps its own idea of what "working" means, so the name is how two of them are
told apart. Change it and you start again from nothing.

---

## `keepBuilds` — how much history is kept

```js
keepBuilds: 5,
```

Every check writes a record of the build it walked into `.staysfixed/`, and that
folder belongs in git — it is the record of what "working" means, not throwaway
evidence. So it grows: one record per check, in your repository, for ever. A
project checked on every commit was accumulating that record with nothing ever
removing it.

At the end of a successful check the older records are cleared out, in three
tiers. Three things are outside the count entirely and are never touched, whatever
this is set to: the reference — the build you shipped, which is the whole point of
the store — the build this run just walked, and anything named by `--against`.

After those:

- the newest `keepBuilds` are kept whole, every recording intact;
- the next `keepBuilds` × 4 are thinned to one recording per journey, so they can
  still say what that build did without keeping every take of it;
- everything behind that is removed, folder and all, oldest first.

The count is builds, not days, and that is deliberate. A project checked on every
commit writes fifty folders a day, so "keep thirty days" is fifteen hundred
folders in somebody's git history — and the same rule throws away a two-month-old
build on a project checked twice a week. The thinned middle tier is the grace
period, and it is cheap: fifteen thinned builds cost about what one untouched one
costs, and they buy back the case a plain cap gets wrong — thirty checks in an
afternoon, then `--against` the build from before lunch.

If any stored record could not be read, **nothing is removed or thinned at all**
and the run says so. Deleting on an incomplete listing is how you lose the one
record that mattered, and a thinned folder can be walked again where a deleted one
cannot.

The run prints one line saying what it cleared. Set it higher if you use
`staysfixed check --against` on older builds a lot; there is no reason to set it
lower than 2.

---

## `suite` — walking your own test suite

```js
suite: { budgetMs: 90000 },
```

`staysfixed check --journeys suite` runs the project's own test suite as well as
everything else: each test file twice inside the scratch copy, every check
reported by name, why each failure failed, and a fingerprint of the test file
itself — so an edited test says plainly that the change is yours.

`budgetMs` is how long that is allowed to take. It defaults to 90 seconds, which
is a statement about how long anyone waits inside an edit-and-check loop before
switching the tool off, not a guess at how long suites take. **Every file the
budget did not reach is named, one by one**, in the report and in the coverage
ledger — never "some tests were skipped" — and every run says which budget was
applied and where it came from.

Set `0` for no budget at all, and the whole suite is walked however long it takes.
Raise it when your suite is slower than 90 seconds and you would rather wait than
have the tail named as uncovered.

The harvest is off unless you ask for it. Running a stranger's whole suite twice
on every check is not a thing to do by default, and a check nobody can afford to
run is a check nobody runs.

---

## `source` — reading the code

Free, exact, runs nothing, and it is the only channel that can see a door nobody
has ever opened.

| Option | What it does |
| --- | --- |
| `folders` | Which folders to read. Left out, it reads the usual ones — `src`, `lib`, `app`, `bin`, `server`, `pages`, `api`, `electron`, `main`, `packages`. That is right for a repository that makes one thing and **misses whole products in a repository that makes several**, so `init` writes the real list. |
| `surface` | Read the source as though it belonged to one kind of product, when the guess is wrong. |

**Needs on the machine:** nothing.

---

## `process` — commands and libraries

Each command runs in a **throwaway copy of your project**, never your working
copy, with the clock stopped and every outbound connection recorded and then
refused.

| Option | What it does |
| --- | --- |
| `commands[]` | The commands worth running. See the entry shape below. |
| `imports[]` | Modules to import and compare the exports of: `{ name, module }`. |
| `skip[]` | Folder names to leave out of the scratch copy. See the warning below. |

A `commands` entry:

```js
process: {
  commands: [
    {
      name: 'demo --help',                  // what it is called in the report
      run: 'node ./cli.js --help',          // the command itself
      describe: 'ask it to print its help', // one line, for a person reading the result
      cwd: 'packages/cli',                  // optional, relative to the project
      stdin: 'yes\n',                       // optional, what to type at it
      env: { LOG_LEVEL: 'debug' },          // optional, added to the frozen set below
      timeoutMs: 60000,                     // optional
      irreversible: false,                  // true = it spends money or sends something
    },
  ],
},
```

`irreversible: true` means the command is watched **asking** — the same charge,
the same amount, the same place — and never allowed to actually do it. That is
reported as a gap in coverage, never as a pass.

`init` only ever fills in `--help` commands by itself, deliberately: a command
named in a manifest could deploy, publish or wipe a database, and running one
because it was listed would be this tool causing the exact damage it exists to
catch. Add the others yourself.

### `process.skip` — and the bar for using it

```js
process: { skip: ['DerivedData', '.gradle'] },
```

Every run copies your project into a scratch folder. That copy is **cloned**, not
copied: on a Mac and on most Linux filesystems it is one call per file that moves
no bytes and shares the blocks until something writes to them. Measured on a
twelve-gigabyte project, most of it an iOS build folder: 41.5 seconds and no disk
used. Where the filesystem cannot clone it falls back to a real copy — slower,
never wrong. If a copy takes over twenty seconds the run says so and points you
at this setting.

**Only put something here if it is regenerated on demand and read by nothing.**
Caches, coverage reports, scratch output. What you skip is missing from **both**
builds, so a product that actually needed it fails the same way twice, there is no
difference to report, and the run comes back clean — a pass for the wrong reason,
which is the single failure this whole tool exists to prevent. Build output,
`node_modules`, lockfiles, fixtures and configuration are all copied every time.
When in doubt, leave it in and let the run be slower.

`skip` can only **add** to what is already left behind: `.git`, `.staysfixed`,
`.turbo`, `.nyc_output`, `coverage`, `.pytest_cache`, `__pycache__`, `.DS_Store`.
There is no way to switch one of those back on, because that could only ever make
runs slower.

### Needs on the machine

| What | Why | Who |
| --- | --- | --- |
| Node 22 or newer | The tool itself | The agent: install Node 22+ |
| A POSIX shell (`/bin/sh`) | Every command is run through a shell | Already there on Mac and Linux |
| `cp` | The scratch clone. Without it the copy still happens, byte by byte, and is slower | Already there on Mac and Linux; Windows goes straight to the plain copy |
| `git` | Working out how far a difference is from the code you changed, and putting an old build back | The agent: install git. Without it every difference is ranked as though you edited nothing |

**What every command is given, and nothing else:** `PATH`, `SHELL=/bin/sh`,
`HOME`, `TMPDIR`/`TEMP`/`TMP` (all pointed at scratch folders), `TZ=UTC`, `LANG`,
`LC_ALL`, `TERM=dumb`, `NO_COLOR=1`, `FORCE_COLOR=0`, `CI=''`, `COLUMNS=80`,
`LINES=24`, `STAYSFIXED=1`, `STAYSFIXED_SEED`, `STAYSFIXED_CLOCK`, plus anything
in the entry's own `env`. Everything else in your shell is deliberately not there:
a command that only works because of a variable you happened to have set is a
command that does not work on anybody else's machine.

**One limit worth knowing:** what a command *sent out into the world* — calls
made, files written, processes started — is only watched when the program being
run is Node. A Python or Go command is compared on what it printed, what it
answered and how it exited.

---

## `http` — a server or an API

Every route is read out of your own source, so a route nobody links to is checked
like any other. Booted on a spare port, one build at a time, never two at once.

| Option | What it does |
| --- | --- |
| `start` | The command that starts it. **It must listen on the `PORT` it is given** — see below. |
| `restore` | A command that puts the data back how it was, so both builds see the same rows. Without it the second run sees whatever the first one wrote. |
| `samples` | One real value per changing part of a route: `{ id: '1', slug: 'a-real-one' }`. A route with a part nobody has given a value for is reported as never looked at, never quietly skipped. |
| `requests[]` | Extra requests the source cannot show — anything needing a body or a header: `{ name, method, url, headers, body, describe, irreversible }`. |
| `irreversible[]` | Route names that spend money, send a message or destroy data. Watched at the moment they are asked for, and stopped before anything happens. |
| `env` | Extra environment for the start command. |
| `nodeEnv` | What `NODE_ENV` is set to. **Defaults to `production`.** |
| `startTimeoutMs` | How long to wait for it to start listening. |
| `watch` | Folders to notice files being written in. |

**The one contract you must meet.** The tool picks a free port and passes it as
`PORT`, with `HOST=127.0.0.1`. Your `start` command has to bind that port. A
server that hard-codes 3000 will be started, will not be found, and the run will
say it could not reach it — because two builds cannot both own port 3000, which
is the whole reason the port is chosen rather than configured.

**A `restore` command that looks like it destroys data it cannot rebuild is
refused, not run.** The refusal is reported; it is never a pass.

### Needs on the machine

| What | Why | Who |
| --- | --- | --- |
| A POSIX shell | To run `start` and `restore` | Already there |
| Docker, **or** a dump file | Only if your server has a database. Both builds have to see identical rows or every difference is really a data difference | A person: install Docker, or point `restore` at a dump the tool may restore |

---

## `web` — a website

Opened in a throwaway browser with the clock stopped, motion killed, randomness
seeded and the internet cut off. What is compared is what the screen **means** —
the roles, names and states a screen reader would read — never the markup, so a
restyled page reports nothing at all.

| Option | What it does |
| --- | --- |
| `start` | The command that boots this build, listening on the `PORT` it is given. **Much better than an address** — see below. |
| `url` / `baseUrl` | Where it already is, if you accept the weaker answer. |
| `screens[]` | `{ name, url }` — the pages to visit. |
| `journeys[]` | Walks through the site: `{ name, steps: [{ click: 'Save' }, …] }`. |
| `samples` | One real value per changing part of a page address. |
| `viewport` | `{ width, height, deviceScaleFactor }`. |
| `colorScheme` | `light` or `dark`. |
| `locale`, `timezone` | Pinned so text is drawn the same way every run. |
| `allowHosts[]` / `allowed[]` | Addresses the page is allowed to reach. Everything else is refused. |
| `refuse[]` | Addresses that must never be reached even if they would work. |
| `allowWrites` | Let the page write to disk. |
| `network` | How outside calls are handled — recorded, replayed or refused. |
| `restore` | A command that puts the data back between runs. |
| `env`, `nodeEnv` | Environment for the start command. |
| `startTimeoutMs`, `timeoutMs`, `settleTimeoutMs` | How long to wait to start, to answer, and to stop moving. |
| `everyStep` | Photograph every step, not just the end of each journey. |

**Give it `start`, not `url`, whenever you can.** One address can only ever serve
one build, so with an address alone both halves of the comparison read the *same*
running copy and a paired run proves nothing. The tool says so on every run that
had only an address.

### Needs on the machine

A browser. `npm install staysfixed` brings the **driver** — `playwright-core`,
about 13MB — and deliberately not a browser: most people checking a command-line
tool should not wait for a 570MB download they will never use.

| What | The command | Who |
| --- | --- | --- |
| The driver, if it somehow is not there | `npm install playwright-core` | The agent, without asking |
| A browser, when there is none on the machine at all | `npx playwright install chromium` | The agent, without asking |

Those are two separate failures and the tool tells them apart — "the driver is
missing" and "the driver is here and there is no browser for it to open" need
different commands, and being given the wrong one is how twenty minutes
disappear.

**It looks for a browser you already have first.** Chrome for Testing, Chromium,
Edge or Chrome, preferring one that is *not* the browser you actually use. Only
when there is nothing at all is the download asked for. And a project that already
drives its own tests with the full `playwright` package is used as it is, never
asked to install a second copy of the same driver.

The download is about 570MB in a shared cache outside your project — 371MB for
Chrome for Testing and 196MB for its headless shell — once per machine, not once
per project.

**Checks never open the browser you use** if there is any other on this machine,
and never your profile. `staysfixed browsers` says which one would be opened and
why; `staysfixed browsers --clean` clears up after a run that was killed.

Environment variables it reads, if you need to point it somewhere unusual:
`PLAYWRIGHT_BROWSERS_PATH` (where browsers were downloaded),
`STAYSFIXED_BROWSER` and `STAYSFIXED_CHROME` (use exactly this binary), and
`LOCALAPPDATA` on Windows.

---

## `electron` — a desktop app

Opened on its own — own settings folder, own ports, own name — and read on both
sides: the window, and the private channels behind it.

| Option | What it does |
| --- | --- |
| `binary` (or `app`) | **The built app.** On a Mac the `.app`; on Windows the `.exe`. This adapter never builds it for you. |
| `identityEnv` | If your app tells a server who it is, name the setting that carries the id: `{ YOUR_APP_DEVICE_ID: '{identity}' }`. Without this two runs can claim the same slot and fight over it — which looks exactly like a bug in your product. |
| `exercise[]` | Private channels to ask to answer: `['settings:read', 'sessions:list']`. A channel is only ever asked when it is named here, because knocking on an unknown door could do anything. |
| `journeys[]` | Walks through the window: `{ name, steps: [{ click: 'New session' }] }`. |
| `contract` | Where to read the declared doors from, when it is not obvious. |
| `appId` | The app's identifier, when it cannot be read from the bundle. |
| `args[]`, `env` | Extra arguments and environment for the app. |
| `windowMatch` | Which window to read, when the app opens more than one. |
| `startTimeoutMs`, `settleTries`, `settleGapMs` | How long to wait for it to open, and how many times to re-read the screen until two readings agree. |

**Note:** `doctor` sometimes says "set `app.binary`". That is version 1's picture
setting. The difference engine reads **`electron.binary`** (or `electron.app`).
Set the one under `electron`.

### Needs on the machine

| What | Why | Who |
| --- | --- | --- |
| Nothing to download | The app is its own Chromium and is driven over its own debugging port | — |
| A **built** app | The adapter never builds it | You: build it the way you normally do — often `npm run build` then `npm run package` — and point `electron.binary` at the result |
| Two free TCP ports per run | One to drive the window, one to read the main process | Automatic |
| `/bin/ps` | Finding and clearing anything an interrupted run left running | Already there on Mac and Linux |

The app is launched with its own `HOME`, `TMPDIR`, `XDG_*` folders, `TZ=UTC` and a
fixed seed and clock, so it cannot read your real settings and cannot leave
anything behind in them.

---

## `android` — an APK on an emulator

Installed on an emulator of its own, walked, then removed. Compared against the
stored record: whether two emulator snapshots come back byte for byte is unproven,
and every run says which mode it used.

| Option | What it does |
| --- | --- |
| `apk` | The built package. Left out, it looks in the usual build folders. |
| `avd` | Which emulator to use. Left out, it takes the first one that is **not** a Play Store image. |
| `serial` | A device already plugged in, or an emulator already running. |
| `journeys[]` / `screens[]` | Walks through the app: `{ name, steps: [{ tap: 'Sign in' }] }`. Left out, it opens the app and reads the first screen. |
| `headless` | `false` shows the emulator window. |
| `reset` | `'uninstall'` removes the app between runs. |
| `locale`, `timezone` | Pinned. |
| `allowTo[]` | Addresses the app is allowed to reach. |
| `settleTries` | How many times to re-read the screen until two readings agree. |

### Needs on the machine

**Java is not needed.** The APK is read directly. That surprises people, so it is
worth saying: everything the package declares can be listed with nothing
installed at all.

To actually run one:

| What | The command | Who |
| --- | --- | --- |
| The Android command line tools | On a Mac: `brew install --cask android-commandlinetools`, then `sdkmanager "platform-tools" "emulator"` | The agent — except **Google's licence has to be accepted once, by a person** |
| The emulator, if the SDK is there without it | `sdkmanager --install emulator` | The agent |
| A system image and an emulator to run it | `sdkmanager --install "system-images;android-33;google_apis;arm64-v8a"` then `avdmanager create avd -n staysfixed -k "system-images;android-33;google_apis;arm64-v8a"` | The agent |
| A built APK | Usually `./gradlew assembleRelease`, or point `android.apk` at one you have | You |

**Pick a plain Google APIs image, never a Play Store one.** A Play Store device
refuses root forever, and without root the files the app writes cannot be seen at
all — so that whole channel goes dark and the run never mentions it as a reason
things look quiet. This is the most likely way to lose coverage on Android without
noticing.

Environment variables it reads: `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`ANDROID_AVD_HOME`. Without them it looks in `~/Library/Android/sdk`,
`~/Android/Sdk`, `~/AppData/Local/Android/Sdk`, `/usr/local/share/android-sdk`
and `/opt/android-sdk`.

Outbound calls are stopped with a device-wide proxy, set before the run and
cleared after it. Nothing inside an encrypted connection is read and **no
certificate is installed on the emulator**.

---

## `ios` — an app on the simulator

Installed on a simulator, opened, and read — the same roles, names and states a
person hears read out to them. One build at a time. macOS only: nothing on Linux
or Windows can run an iOS simulator.

| Option | What it does |
| --- | --- |
| `app` | The built app bundle for the simulator. Left out, it looks where builds land. |
| `deviceType`, `runtime` | Which simulator and which system: `'iPhone 17'`, `'iOS 26.4'`. Left out it picks a sensible one and says which. |
| `device` | An exact simulator that already exists, by name or id. |
| `journeys[]` | Walks through the app: `{ name, steps: [{ tap: 'Sign in' }] }`. |
| `openUrls[]` | Addresses to open the app with, for a screen only reached by a link. |
| `appearance` | `light` or `dark`. |
| `reset` | `'erase'` wipes the simulator between runs. |
| `logProcess` | Which process to read the logs of, when it is not the app itself. |

### Needs on the machine

| What | The command | Who |
| --- | --- | --- |
| Xcode | **A person.** It is a free download from the Mac App Store, it is about 10 gigabytes, and it has a licence to accept the first time it opens. Once it is installed nothing else here needs doing by hand | A person |
| The command line tools | `xcode-select --install` | The agent |
| An iOS runtime to run | `xcodebuild -downloadPlatform iOS` | The agent |
| A built app | `xcodebuild -scheme <YourScheme> -sdk iphonesimulator -derivedDataPath build`, or point `ios.app` at one | You. The adapter never builds it: guessing a scheme produces a build nobody asked for |

The programs it uses, so you can check for them yourself: `xcrun`, `simctl`,
`xcode-select`, `xcodebuild`, `clang` and `plutil`.

**`clang` is the one that goes quiet.** Reading what a control on screen *means*
is done by a small reader compiled for the simulator SDK at run time. Without the
command line tools that compile fails, the meaning channel is dark, and what is
left is thinner than it looks. `staysfixed doctor` says so; a run that has already
started does not always.

If `simctl` is installed but does not answer, open `Simulator.app` once, or run
`sudo xcode-select --reset`.

---

## `windows` — a native Windows program

A Windows window can only be read from Windows, so this needs a machine running
one. An ssh host you already have counts, including a WSL shell on a Windows
machine, and **nothing is installed on that machine**.

| Option | What it does |
| --- | --- |
| `host` | The ssh host that reaches a logged-in Windows desktop. |
| `remoteExe` | The built program already on that machine: `'C:\\Users\\you\\YourApp\\YourApp.exe'`. Much faster than copying. |
| `exe` | The built program here, to be copied over before each run. |
| `watchDirs[]` | Folders on that machine to watch for files the app writes. |
| `journeys[]` | Walks through the window. |
| `args[]`, `cwd` | Arguments and working folder for the program. |

### Needs on the machine

**On your machine:**

| What | Why |
| --- | --- |
| `ssh` | Everything goes down one ssh connection |
| `tar` | How a local build is streamed across — not `scp` |
| An entry in `~/.ssh/config` with **key-based** login | The connection is made with `BatchMode=yes`, so a host that wants a password is reported as unreachable rather than sitting there waiting for one nobody will type. Test it with `ssh <host> true` |

**On the far machine:**

| What | Why | Who |
| --- | --- | --- |
| `node` | The small program that reads the screen is sent down the connection each run and disappears when it closes. Nothing is written to that machine's disk | The agent: `ssh <host> 'sudo apt-get install -y nodejs'`, or whatever that machine installs packages with |
| `powershell.exe` | Reading a Windows window. It is found at one of three known paths, not by asking the shell — that question answers "no" on a machine with Windows right there | Already there on any Windows machine |
| **Somebody signed in** | UI Automation reads a desktop session. There is nothing to read on a desktop nobody has signed into | A person: sign in once and leave the session running. Locking the screen afterwards is fine; signing out is not |
| The screen unlocked | Only for full-screen pictures. Everything else works locked | A person |

**Two builds can never run at once**, because Windows shows one desktop. Runs are
one after the other and the comparison is genuinely weaker here than anywhere
else. If your Windows product is Electron — most are — use the `electron` block
instead: it is driven over the debug port, from any machine, and this adapter
refuses Electron apps on purpose so nobody gets the weaker answer by accident.

---

## Environment variables, in one place

Ones you might want to set:

| Variable | What it does |
| --- | --- |
| `NO_COLOR`, `STAYSFIXED_NO_COLOR` | Plain text, no colour. `--no-color` does the same thing. |
| `STAYSFIXED_OFFLINE` | Any value stops `doctor` dialling other machines. |
| `PLAYWRIGHT_BROWSERS_PATH` | Where browsers were downloaded. |
| `STAYSFIXED_BROWSER`, `STAYSFIXED_CHROME` | Use exactly this browser binary. |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME` | Where the Android SDK and its emulators are. |

Everything else — the frozen clock, the seed, the temporary folders — is set *by*
the tool, into the thing being checked, and is listed under `process` above.

---

## When you are not sure

```
staysfixed doctor          # what this machine can drive, and the exact command for each gap
staysfixed doctor --json   # the same answer as one object, for an agent
staysfixed init --force    # read the repository again and rewrite the settings
```

Nothing `doctor` lists as missing got there without failing a real check first, so
you are never sent shopping for something that already works.
