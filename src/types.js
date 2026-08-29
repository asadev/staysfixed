/**
 * Stays Fixed — the shared contract.
 *
 * This file holds only JSDoc typedefs. Every module in `src/` types itself against
 * these shapes, so the pieces fit without importing each other's internals.
 *
 * Nothing here runs. It exists so `npm run typecheck` can prove the seams line up.
 */

// ---------------------------------------------------------------------------
// Config — what a project writes in staysfixed.config.js / .json
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AppConfig
 * @property {'web'|'electron'} kind          What we are opening.
 * @property {string} [url]                   web: the address to open (also the base for relative screen urls).
 * @property {string} [start]                 web: shell command that starts the app (optional; we wait for `url`).
 * @property {string} [cwd]                   Working directory for `start` / `binary`.
 * @property {string} [binary]                electron: path to the executable (or a .app bundle).
 * @property {string[]} [args]                electron: extra argv.
 * @property {Record<string,string>} [env]    Extra environment for the launched process.
 * @property {number} [startTimeoutMs]        How long to wait for the app to answer. Default 60000.
 * @property {number} [debugPort]             CDP port to use. Default: a free one we pick.
 * @property {string} [attach]                Attach to an already-running CDP endpoint instead of launching, e.g. "http://127.0.0.1:9333".
 * @property {string} [browser]               web: path to a Chrome/Chromium/Edge binary. Default: found on the system.
 * @property {boolean} [headless]             web: run the browser headless. Default true.
 * @property {string} [windowMatch]           electron: only drive the window whose title/url contains this.
 */

/**
 * @typedef {object} ViewportConfig
 * @property {number} width                   CSS pixels. Default 1440.
 * @property {number} height                  CSS pixels. Default 900.
 * @property {number} [deviceScaleFactor]     Default 2 (retina-sharp, still deterministic).
 * @property {boolean} [mobile]               Emulate a touch device. Default false.
 */

/**
 * @typedef {object} SettleConfig
 * @property {number} [frames]                Consecutive identical frames required. Default 2.
 * @property {number} [intervalMs]            Gap between frames. Default 250.
 * @property {number} [timeoutMs]             Give up after this. Default 10000.
 * @property {number} [maxDriftPixels]        Pixels allowed to differ and still count as "identical". Default 0.
 */

/**
 * @typedef {object} FreezeConfig
 * @property {string|false} [clock]           ISO time the app always believes it is. Default '2026-01-01T12:00:00.000Z'. false = leave the clock alone.
 * @property {string} [timezone]              IANA zone forced on the page. Default 'UTC'.
 * @property {string} [locale]                BCP-47 locale forced on the page. Default 'en-US'.
 * @property {boolean} [motion]               Kill animations, transitions, carets, smooth scroll. Default true.
 * @property {'seeded'|'off'} [random]        Seed Math.random and crypto randomness. Default 'seeded'.
 * @property {number} [seed]                  The seed. Default 20260101.
 * @property {boolean} [fonts]                Wait for document.fonts.ready and pin text rendering. Default true.
 * @property {'replay'|'block-external'|'live'} [network]  How to handle requests. Default 'block-external'.
 * @property {string[]} [networkAllow]        Globs always allowed through, even in 'block-external'.
 * @property {SettleConfig} [settle]
 * @property {boolean} [hideScrollbars]       Default true.
 * @property {boolean} [hideCaret]            Default true.
 */

/**
 * @typedef {object} ToleranceConfig
 * @property {number} [pixels]                Share of pixels allowed to differ, 0..1. Default 0.0005.
 * @property {number} [threshold]             Per-pixel colour sensitivity, 0..1 (lower = stricter). Default 0.12.
 * @property {boolean} [antialiasing]         Ignore anti-aliasing noise. Default true.
 * @property {number} [maxPixels]             Hard cap on differing pixels, overrides `pixels` when set.
 */

/**
 * A rectangle painted over before comparing, in CSS pixels of the captured page.
 * @typedef {object} MaskRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/** @typedef {string|MaskRect} Mask  A CSS selector (every match is painted over) or an explicit rectangle. */

/**
 * One declarative step. Exactly one action key should be set.
 * @typedef {object} Step
 * @property {string} [goto]                  Navigate. Relative paths resolve against app.url.
 * @property {string} [click]                 CSS selector to click.
 * @property {string} [type]                  CSS selector to type into (pair with `text`).
 * @property {string} [text]                  Text for `type`.
 * @property {string} [press]                 Key to press, e.g. 'Enter', 'Escape'.
 * @property {string} [hover]                 CSS selector to hover.
 * @property {string} [waitFor]               CSS selector to wait for.
 * @property {string} [waitForGone]           CSS selector to wait to disappear.
 * @property {number} [wait]                  Milliseconds to wait (last resort; settle usually beats this).
 * @property {string} [scrollTo]              CSS selector to scroll into view.
 * @property {string} [evaluate]              JavaScript to run in the page.
 * @property {string} [note]                  Human note, shown in reports.
 */

/**
 * @typedef {object} ScreenConfig
 * @property {string} name                    File-safe id, e.g. 'sessions-empty'.
 * @property {string} [describe]              Plain-language description shown to humans.
 * @property {string} [url]                   Shorthand for a single `goto` step.
 * @property {Step[]} [steps]                 Declarative steps run before the shutter.
 * @property {Step[]} [after]                 Steps run AFTER the picture, to put the app back.
 *                                          Needed when a screen changes something the app SAVES —
 *                                          a reload gives back the screen, not the app's memory.
 * @property {(page: PageApi) => Promise<void>} [do]  Or code, when the config is JS.
 * @property {Mask[]} [masks]                 Extra masks for this screen only.
 * @property {ToleranceConfig} [tolerance]    Override tolerance for this screen only.
 * @property {ViewportConfig} [viewport]      Override viewport for this screen only.
 * @property {string} [clip]                  Capture only this element instead of the whole page.
 * @property {boolean} [fullPage]             Capture the full scrollable page. Default false.
 * @property {boolean} [skip]                 Temporarily leave this screen out.
 * @property {FreezeConfig} [freeze]          Per-screen freeze overrides.
 */

/**
 * @typedef {object} WalkConfig
 * @property {string} [describe]
 * @property {ScreenConfig[]} [steps]         Screens walked in order before a release. Defaults to `screens`.
 */

/**
 * @typedef {object} McpConfig
 * @property {boolean} [allowApprove]         Let an agent approve pictures. Default FALSE, on purpose.
 * @property {boolean} [allowMark]            Let an agent write known-good markers. Default false.
 */

/**
 * @typedef {object} StaysFixedConfig
 * @property {AppConfig} app
 * @property {ViewportConfig} [viewport]
 * @property {FreezeConfig} [freeze]
 * @property {ToleranceConfig} [tolerance]
 * @property {Mask[]} [masks]                 Masks applied to every screen.
 * @property {ScreenConfig[]} [screens]
 * @property {string} [guards]                Folder holding guard files. Default '.staysfixed/guards'.
 * @property {WalkConfig} [walk]
 * @property {McpConfig} [mcp]
 * @property {string} [dir]                   Where state lives. Default '.staysfixed'.
 * @property {number} [flakeLimit]            Flakes before a check is condemned. Default 2.
 * @property {number} [retries]               Re-captures on a failing screen before calling it a real change. Default 1.
 * @property {number} [concurrency]           Screens captured at once. Default 1 (determinism first).
 */

/** @typedef {StaysFixedConfig & Required<Pick<StaysFixedConfig,'viewport'|'freeze'|'tolerance'|'masks'|'screens'|'guards'|'dir'|'flakeLimit'|'retries'|'concurrency'|'mcp'>>} ResolvedConfig */

// ---------------------------------------------------------------------------
// Project — resolved paths and loaded config
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProjectPaths
 * @property {string} root                    Project root (folder holding the config).
 * @property {string} dir                     Absolute .staysfixed folder.
 * @property {string} approved                Approved pictures (committed).
 * @property {string} results                 Latest run output (ignored by git).
 * @property {string} diffs                   Diff images for the latest run.
 * @property {string} markers                 Known-good markers.
 * @property {string} guards                  Guard files.
 * @property {string} fixtures                Recorded network replies.
 * @property {string} historyFile             Flake register.
 * @property {string} reportFile              Self-contained HTML report.
 * @property {string} configFile              The config that was loaded.
 */

/**
 * @typedef {object} Project
 * @property {ResolvedConfig} config
 * @property {ProjectPaths} paths
 */

// ---------------------------------------------------------------------------
// Driving — CDP, browser, page
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CdpSession
 * @property {(method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>} send
 * @property {(event: string, handler: (params: any, sessionId?: string) => void) => () => void} on
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 */

/**
 * @typedef {object} LaunchedApp
 * @property {CdpSession} cdp
 * @property {PageHandle} page
 * @property {() => Promise<void>} close       Stop everything we started. Never touches anything we attached to.
 * @property {string} endpoint                 The CDP endpoint in use.
 * @property {number|null} pid                 The process we spawned, if any.
 * @property {'web'|'electron'} kind
 */

/**
 * The surface a screen recipe or a guard is handed.
 * @typedef {object} PageApi
 * @property {(url: string) => Promise<void>} goto
 * @property {(selector: string, opts?: {timeoutMs?: number}) => Promise<void>} click
 * @property {(selector: string, text: string) => Promise<void>} type
 * @property {(key: string) => Promise<void>} press
 * @property {(selector: string) => Promise<void>} hover
 * @property {() => Promise<void>} moveMouseAway   Park the pointer in the far corner so nothing is left hovered.
 * @property {(selector: string, opts?: {timeoutMs?: number}) => Promise<void>} waitFor
 * @property {(selector: string, opts?: {timeoutMs?: number}) => Promise<void>} waitForGone
 * @property {(selector: string) => Promise<void>} scrollTo
 * @property {(ms: number) => Promise<void>} wait
 * @property {(js: string) => Promise<any>} evaluate
 * @property {(selector: string) => Promise<boolean>} visible
 * @property {(selector: string) => Promise<boolean>} exists
 * @property {(selector: string) => Promise<string>} textOf
 * @property {(selector: string) => Promise<number>} count
 * @property {(selector: string) => Promise<MaskRect|null>} boxOf
 * @property {() => Promise<string>} url
 * @property {() => Promise<string>} title
 * @property {(opts?: CaptureOptions) => Promise<Buffer>} shoot   Raw screenshot, no settle, no compare.
 * @property {(v: ViewportConfig) => Promise<void>} setViewport
 * @property {() => string[]} consoleErrors
 */

/**
 * @typedef {object} CaptureOptions
 * @property {boolean} [fullPage]
 * @property {string} [clip]                  Selector to clip to.
 * @property {MaskRect} [rect]                Explicit rectangle to clip to.
 */

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PictureMeta
 * @property {string} name
 * @property {string} [describe]
 * @property {number} width
 * @property {number} height
 * @property {number} deviceScaleFactor
 * @property {string} sha256
 * @property {string} approvedAt              ISO timestamp.
 * @property {string} approvedBy              git user.name <email>, or 'unknown'.
 * @property {string} [gitSha]                Commit the approval was made against.
 * @property {string} tool                    Stays Fixed version that took it.
 * @property {string} [platform]              e.g. 'darwin-arm64'. Pictures are platform-tagged; comparing across platforms warns.
 */

/**
 * @typedef {'passed'|'changed'|'new'|'missing'|'failed'|'skipped'|'flaky'} CheckStatus
 */

/**
 * @typedef {object} PictureResult
 * @property {string} name
 * @property {string} [describe]
 * @property {CheckStatus} status
 * @property {number} [diffPixels]
 * @property {number} [diffRatio]
 * @property {string} [approvedPath]
 * @property {string} [actualPath]
 * @property {string} [diffPath]
 * @property {string} [message]               Plain-language explanation.
 * @property {number} durationMs
 * @property {number} [attempts]
 * @property {string[]} [consoleErrors]
 * @property {{width:number,height:number}} [size]
 * @property {{width:number,height:number}} [approvedSize]
 */

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GuardApi
 * @property {PageApi} page                                       Full page control.
 * @property {(path: string) => Promise<void>} open               Shorthand for page.goto.
 * @property {(selector: string) => Promise<void>} click
 * @property {(what: string, check: () => unknown | Promise<unknown>) => Promise<void>} expect
 *           Assert in plain language: expect('the sidebar is hidden', () => ...).
 * @property {(cmd: string, opts?: {cwd?: string, timeoutMs?: number}) => Promise<{code: number, stdout: string, stderr: string}>} run
 *           Run a shell command, for guards that are not about the screen.
 * @property {(file: string) => Promise<string>} read             Read a project file.
 * @property {Project} project
 */

/**
 * @typedef {object} Guard
 * @property {string} name                    Plain language. "the sidebar still collapses".
 * @property {string} [fixed]                 When the bug was fixed (free text or a date).
 * @property {string} [because]               Why this guard exists — the story of the bug.
 * @property {string} [link]                  Issue / commit / session note.
 * @property {boolean} [skip]
 * @property {number} [timeoutMs]             Default 30000.
 * @property {(app: GuardApi) => Promise<void>} run
 * @property {string} [file]                  Filled in by the loader.
 */

/**
 * @typedef {object} GuardResult
 * @property {string} name
 * @property {CheckStatus} status
 * @property {string} [message]
 * @property {string} [failedAt]              The plain-language expectation that failed.
 * @property {string} [file]
 * @property {string} [because]
 * @property {number} durationMs
 * @property {number} [attempts]
 */

// ---------------------------------------------------------------------------
// Runs, markers, history
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RunSummary
 * @property {string} id                      Run id, sortable: '20260829-013245'.
 * @property {string} startedAt
 * @property {number} durationMs
 * @property {PictureResult[]} pictures
 * @property {GuardResult[]} guards
 * @property {{passed:number,changed:number,new:number,failed:number,missing:number,skipped:number}} totals
 * @property {boolean} ok
 * @property {GitInfo} git
 * @property {string} tool
 * @property {string} platform
 * @property {string[]} [condemned]           Names of checks that have flaked past the limit.
 */

/**
 * @typedef {object} GitInfo
 * @property {string|null} sha
 * @property {string|null} shortSha
 * @property {string|null} branch
 * @property {boolean} dirty
 * @property {string|null} user
 */

/**
 * @typedef {object} Marker
 * @property {string} label                   'v0.15.0', 'before-the-store-work', anything.
 * @property {string} at                      ISO timestamp.
 * @property {string} [note]
 * @property {GitInfo} git
 * @property {Record<string,string>} pictures  screen name -> sha256 of the approved picture.
 * @property {Record<string,CheckStatus>} guards
 * @property {string} tool
 * @property {string} platform
 */

/**
 * @typedef {object} HistoryEntry
 * @property {string} name
 * @property {'picture'|'guard'} kind
 * @property {number} runs
 * @property {number} flakes                  Times it changed its mind without the code changing.
 * @property {CheckStatus[]} recent                Last N statuses, newest last.
 * @property {string} [lastFlakeAt]
 * @property {string} [lastFlakeGitSha]
 * @property {boolean} [condemned]            Past the flake limit — fix it or delete it.
 */

/** @typedef {Record<string, HistoryEntry>} History */

export {};

// ---------------------------------------------------------------------------
// Extra shapes the modules pass between themselves
// ---------------------------------------------------------------------------

/**
 * What `createPage` actually returns: the public PageApi plus the plumbing the
 * freeze layer and the capture loop need. Screens and guards only ever see PageApi.
 * @typedef {PageApi & {
 *   send: (method: string, params?: Record<string, unknown>) => Promise<any>,
 *   on: (event: string, handler: (params: any) => void) => () => void,
 *   sessionId: string,
 *   targetId: string,
 *   addInitScript: (source: string) => Promise<string>,
 *   removeInitScript: (id: string) => Promise<void>,
 *   insertCss: (css: string) => Promise<string>,
 *   removeCss: (id: string) => Promise<void>,
 *   baseUrl: string|null,
 *   clearConsole: () => void,
 * }} PageHandle
 */

/**
 * @typedef {object} FreezeHandle
 * @property {() => Promise<void>} release      Undo everything that can be undone.
 * @property {() => FreezeStats} stats
 */

/**
 * @typedef {object} FreezeStats
 * @property {number} requestsAllowed
 * @property {number} requestsBlocked
 * @property {number} requestsReplayed
 * @property {number} requestsRecorded
 * @property {string[]} blockedUrls
 */

/**
 * @typedef {object} SettleReport
 * @property {boolean} settled
 * @property {number} attempts
 * @property {number} lastDriftPixels
 * @property {number} waitedMs
 */

/**
 * @typedef {object} CaptureReport
 * @property {Buffer} png
 * @property {number} width
 * @property {number} height
 * @property {SettleReport} settle
 * @property {string[]} consoleErrors
 * @property {FreezeStats} [freeze]
 */

/**
 * @typedef {object} CompareReport
 * @property {boolean} equal
 * @property {number} diffPixels
 * @property {number} diffRatio
 * @property {Buffer|null} diffPng
 * @property {boolean} sizeMismatch
 * @property {{width:number,height:number}} size
 * @property {{width:number,height:number}} approvedSize
 */

/**
 * @typedef {object} WalkStep
 * @property {number} index
 * @property {string} name
 * @property {string} [describe]
 * @property {string} file          Absolute path to the photo of this step.
 * @property {string} [url]
 * @property {string} [title]
 * @property {number} durationMs
 * @property {string[]} [consoleErrors]
 * @property {string} [error]
 */

/**
 * @typedef {object} WalkReport
 * @property {string} id
 * @property {string} dir
 * @property {WalkStep[]} steps
 * @property {boolean} ok
 * @property {GitInfo} git
 * @property {string} [reportFile]
 */

/**
 * @typedef {object} TraceFinding
 * @property {string} name
 * @property {'unchanged'|'changed'|'unknown'} verdict
 * @property {Marker} [lastGood]     Newest marker where this screen looked like it does now.
 * @property {Marker} [firstBad]     Oldest marker after that where it did not.
 * @property {{sha: string, shortSha: string, subject: string, author: string, date: string}[]} [commits]
 * @property {string[]} [files]
 * @property {string} [message]
 */

/**
 * @typedef {object} TraceReport
 * @property {TraceFinding[]} findings
 * @property {number} markersSearched
 * @property {string} [message]
 */

// ---------------------------------------------------------------------------
// Live events — what a run tells anyone watching, as it happens
// ---------------------------------------------------------------------------

/**
 * One thing that happened during a run.
 *
 * The terminal, the watch window and any future listener all read the same stream, so a
 * run only has to describe itself once. Every event carries `at` (milliseconds since the
 * run began) so a watcher can draw a timeline without keeping its own clock.
 *
 * @typedef {object} RunEvent
 * @property {'run:start'|'screen:start'|'screen:shot'|'screen:done'|'guard:start'|'guard:done'|'phase'|'note'|'run:done'} type
 * @property {number} at                      Milliseconds since the run started.
 * @property {string} [name]                  Screen or guard name.
 * @property {string} [describe]              The plain-language description.
 * @property {number} [index]                 1-based position within its phase.
 * @property {number} [total]                 How many there are in this phase.
 * @property {CheckStatus} [status]
 * @property {number} [durationMs]
 * @property {number} [diffPixels]
 * @property {number} [diffRatio]
 * @property {string} [message]
 * @property {string} [failedAt]              The plain-language expectation that failed.
 * @property {string} [because]               Why a guard exists.
 * @property {string} [thumbnail]             A small JPEG as a data: URI — an instant preview, shown
 *                                          while the real file is still being written.
 * @property {string} [shotFile]              file:// URL of the FULL-RESOLUTION picture just taken.
 *                                          The watch panel is itself a local page, so it can load the
 *                                          real PNG off disk and zoom into actual pixels — a scaled-up
 *                                          thumbnail is unreadable, which is the whole point of looking.
 * @property {string} [approvedFile]          file:// URL of the approved picture.
 * @property {string} [diffFile]              file:// URL of the difference image.
 * @property {string} [approvedThumb]
 * @property {string} [diffThumb]
 * @property {RunSummary} [summary]           Only on 'run:done'.
 * @property {{screens: number, guards: number, app: string, project: string, watching: boolean}} [plan]
 *           Only on 'run:start'.
 */

/**
 * @typedef {object} RunEvents
 * @property {(event: RunEvent) => void} emit
 * @property {(listener: (event: RunEvent) => void) => () => void} on
 * @property {() => number} elapsed
 * @property {() => RunEvent[]} history       Everything so far, so a late listener catches up.
 */

/**
 * @typedef {object} WatchOptions
 * @property {boolean} [enabled]
 * @property {number} [width]                 Panel width in CSS pixels. Default 460.
 * @property {number} [height]                Default: as tall as the app.
 * @property {'right'|'left'} [side]          Which side of the app to sit on. Default 'right'.
 * @property {boolean} [keepOpen]             Leave the panel up after the run. Default true.
 * @property {boolean} [foreground]           Bring the panel to the front. Default false.
 * @property {boolean} [snap]                 Pin the app to a screen edge and sit flush against it. Default true.
 * @property {'dark'|'light'|'system'} [theme]  Default 'dark'. The panel opens on a brand new browser
 *                                          profile, and a fresh profile insists the computer is in light
 *                                          mode however it is really set — so the look is stated, not guessed.
 */

/**
 * Where a run spent its time. Printed by `--profile`, and drawn in the watch window.
 * @typedef {object} Timings
 * @property {number} launch
 * @property {number} steps
 * @property {number} prepare
 * @property {number} settle
 * @property {number} compare
 * @property {number} guards
 * @property {number} other
 * @property {number} total
 */
