/**
 * The Android machinery, kept apart from the policy.
 *
 * Everything in this file is mechanical: find the tools, talk to a device, read an APK,
 * read what is on the screen, press something, write down what went out. No decisions about
 * what is worth observing and no `Observation` is built here — that is `android.js`, and the
 * split is the same one `web.js` and `web-driver.js` already use, for the same reason: the
 * mechanical half is the half that has to be tested against a real device, and it should be
 * possible to do that without dragging the engine in.
 *
 * Two things in here are worth knowing about before reading the rest.
 *
 * FIRST — reading an APK needs nothing installed. `aapt2 dump badging` is the usual way to
 * ask an APK what is inside it, and it needs a Java runtime, which is exactly the thing a
 * stranger's machine is least likely to have. So the ZIP and the binary XML are both read
 * here, in about three hundred lines, with nothing but `node:zlib`. The whole contract
 * channel — the package name, the version, every permission it asks for, every activity,
 * service, receiver and provider it declares and which of them are open to other apps — is
 * therefore free on any machine, before anything is installed and before an emulator exists.
 * That is the Android equivalent of reading 452 message channels out of a desktop app
 * without running it.
 *
 * SECOND — nothing is ever addressed by where it is on screen. A screen coordinate changes
 * when the font scale changes, when a keyboard opens, when a phrase gets longer in another
 * language; comparing on coordinates would report a difference every time and finding a
 * button by coordinate would press the wrong thing. So every control is addressed by what it
 * IS — its resource id, failing that what a screen reader would call it, failing that its
 * text, failing that its kind and its position among its own siblings — and a tap works by
 * looking that address up in the tree that is on screen right now and pressing the middle of
 * whatever it found. The coordinate is worked out fresh every single time and is never
 * stored, never compared.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import http from 'node:http';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Finding the tools
// ---------------------------------------------------------------------------

/**
 * Where an Android SDK lives on this machine, best guess first.
 *
 * The environment variables are checked before the usual folders because somebody who set
 * one meant it. `ANDROID_HOME` is the old name and `ANDROID_SDK_ROOT` the new one; both are
 * still in the wild and both are read.
 *
 * @returns {string[]}
 */
export function sdkCandidates() {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, 'Library/Android/sdk'),
    path.join(home, 'Android/Sdk'),
    path.join(home, 'AppData/Local/Android/Sdk'),
    '/usr/local/share/android-sdk',
    '/opt/android-sdk',
  ].filter(/** @returns {p is string} */ (p) => typeof p === 'string' && p !== '');
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function runnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Look for one program in the SDK, then on the PATH.
 *
 * @param {string[]} relatives   Places inside an SDK, best first.
 * @param {string} onPath        What it is called if it happens to be on the PATH.
 * @returns {string|null}
 */
function findTool(relatives, onPath) {
  for (const sdk of sdkCandidates()) {
    for (const rel of relatives) {
      const full = path.join(sdk, rel);
      if (runnable(full)) return full;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const full = path.join(dir, onPath);
    if (runnable(full)) return full;
  }
  return null;
}

/** @returns {string|null} */
export function findAdb() {
  return findTool(['platform-tools/adb', 'platform-tools/adb.exe'], process.platform === 'win32' ? 'adb.exe' : 'adb');
}

/** @returns {string|null} */
export function findEmulator() {
  return findTool(['emulator/emulator', 'emulator/emulator.exe'], process.platform === 'win32' ? 'emulator.exe' : 'emulator');
}

/**
 * Every AVD this machine has, read straight off disk.
 *
 * Read from the folder rather than asked of `emulator -list-avds`, because the folder
 * answers instantly and also says which system image each one uses, which is what decides
 * whether the device can be rooted — and being able to root decides whether the files an app
 * writes can be seen at all.
 *
 * @returns {{name: string, target: string, image: string, playStore: boolean, dir: string}[]}
 */
export function listAvds() {
  const dir = process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
  /** @type {{name: string, target: string, image: string, playStore: boolean, dir: string}[]} */
  const out = [];
  /** @type {string[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.ini') || entry.includes('.avd')) continue;
    const name = entry.slice(0, -4);
    const avdDir = path.join(dir, `${name}.avd`);
    /** @type {Record<string, string>} */
    const config = {};
    try {
      for (const line of fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) config[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    } catch {
      continue;
    }
    out.push({
      name,
      target: config.target ?? 'unknown',
      image: config['image.sysdir.1'] ?? '',
      playStore: config['PlayStore.enabled'] === 'true',
      dir: avdDir,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Talking to a device
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Ran
 * @property {boolean} ok
 * @property {number} code
 * @property {string} out
 * @property {string} err
 * @property {number} ms
 */

/**
 * Run one program and wait for it.
 *
 * `execFile` is used rather than a shell so nothing in a device's output can ever be read as
 * a command. The timeout is generous by default because installing an APK on a cold emulator
 * genuinely does take the better part of a minute, and a timeout that fires during a normal
 * install would report the install as a difference.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{timeoutMs?: number, signal?: AbortSignal, cwd?: string, input?: string, maxBuffer?: number}} [opts]
 * @returns {Promise<Ran>}
 */
export function run(file, args, opts = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 120000,
        signal: opts.signal,
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const anyError = /** @type {any} */ (error);
        resolve({
          ok: !error,
          code: anyError?.code === undefined ? (error ? 1 : 0) : Number(anyError.code) || 0,
          out: String(stdout ?? ''),
          err: String(stderr ?? '') || (error ? String(anyError.message ?? error) : ''),
          ms: Date.now() - started,
        });
      },
    );
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input);
  });
}

/**
 * One device, and every way of asking it something.
 *
 * A tiny object rather than free functions taking a serial everywhere, because the serial is
 * on literally every call and forgetting it on one of them would silently talk to somebody
 * else's phone.
 */
export class Device {
  /**
   * @param {string} adb    Path to adb.
   * @param {string} serial e.g. `emulator-5566`.
   * @param {{signal?: AbortSignal, log?: (m: string) => void}} [opts]
   */
  constructor(adb, serial, opts = {}) {
    this.adb = adb;
    this.serial = serial;
    this.signal = opts.signal;
    this.log = opts.log ?? (() => {});
    /** Set once we know whether `adb root` worked, so we stop asking. */
    this.rooted = /** @type {boolean|null} */ (null);
  }

  /**
   * @param {string[]} args
   * @param {{timeoutMs?: number, input?: string}} [opts]
   * @returns {Promise<Ran>}
   */
  cmd(args, opts = {}) {
    return run(this.adb, ['-s', this.serial, ...args], { ...opts, signal: this.signal });
  }

  /**
   * Run a shell command on the device.
   *
   * The command is passed as a single string because that is what `adb shell` does with it
   * anyway, and pretending otherwise would only hide the fact. Callers must not build one of
   * these out of anything a device told them.
   *
   * @param {string} command
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<Ran>}
   */
  shell(command, opts = {}) {
    return this.cmd(['shell', command], opts);
  }

  /**
   * Run something and get raw bytes back — a screenshot, a file.
   * @param {string} command
   * @returns {Promise<Buffer>}
   */
  bytes(command) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.adb, ['-s', this.serial, 'exec-out', command], { signal: this.signal });
      /** @type {Buffer[]} */
      const chunks = [];
      child.stdout.on('data', (b) => chunks.push(b));
      child.on('error', reject);
      child.on('close', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * Ask for root, and remember the answer.
   *
   * A Play Store system image refuses, permanently, and that refusal is not a failure — it
   * is a fact about the device that changes what can be seen, and the adapter reports it as
   * missing coverage rather than pretending the files it cannot read are unchanged.
   *
   * @returns {Promise<boolean>}
   */
  async root() {
    if (this.rooted !== null) return this.rooted;
    const asked = await this.cmd(['root'], { timeoutMs: 30000 });
    if (/cannot run as root|not allowed/i.test(`${asked.out}${asked.err}`)) {
      this.rooted = false;
      return false;
    }
    await this.cmd(['wait-for-device'], { timeoutMs: 60000 });
    const who = await this.shell('id -u', { timeoutMs: 15000 });
    this.rooted = who.out.trim() === '0';
    return this.rooted;
  }

  /**
   * Wait until the device has actually finished booting.
   *
   * Three questions rather than one, and they are not the same question. `adb wait-for-device`
   * returns as soon as the daemon answers, which is long before anything can be installed;
   * `sys.boot_completed` means the system is up; and the package manager can still be busy
   * for a few seconds after that, which is exactly when an install fails with a message that
   * looks like a real problem.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<{ready: boolean, ms: number, why: string}>}
   */
  async waitUntilReady(timeoutMs = 300000) {
    const started = Date.now();
    await this.cmd(['wait-for-device'], { timeoutMs });
    while (Date.now() - started < timeoutMs) {
      const booted = await this.shell('getprop sys.boot_completed', { timeoutMs: 15000 });
      if (booted.out.trim() === '1') {
        const pm = await this.shell('pm path android', { timeoutMs: 20000 });
        if (pm.ok) return { ready: true, ms: Date.now() - started, why: 'the device finished booting and the package manager is answering' };
      }
      await pause(1000, this.signal);
    }
    return { ready: false, ms: Date.now() - started, why: `the device did not finish booting within ${Math.round(timeoutMs / 1000)} seconds` };
  }

  /**
   * @returns {Promise<Record<string, string>>}
   */
  async facts() {
    const asked = await this.shell(
      'getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.model; getprop ro.build.fingerprint; getprop ro.hardware',
      { timeoutMs: 20000 },
    );
    const [release, sdk, model, fingerprint, hardware] = asked.out.split('\n').map((s) => s.trim());
    return { release, sdk, model, fingerprint, hardware, emulator: String(/goldfish|ranchu/.test(hardware ?? '')) };
  }
}

/**
 * Every device adb can see, with enough about each to choose one.
 *
 * @param {string} adb
 * @param {AbortSignal} [signal]
 * @returns {Promise<{serial: string, state: string, emulator: boolean, avd: string|null}[]>}
 */
export async function listDevices(adb, signal) {
  const asked = await run(adb, ['devices', '-l'], { timeoutMs: 30000, signal });
  /** @type {{serial: string, state: string, emulator: boolean, avd: string|null}[]} */
  const out = [];
  for (const line of asked.out.split('\n').slice(1)) {
    const bits = line.trim().split(/\s+/);
    if (bits.length < 2 || bits[0] === '') continue;
    out.push({
      serial: bits[0],
      state: bits[1],
      emulator: bits[0].startsWith('emulator-'),
      avd: (/\bdevice:([^\s]+)/.exec(line) ?? [])[1] ?? null,
    });
  }
  return out;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Reading an APK without installing anything
// ---------------------------------------------------------------------------

/**
 * Pull one file out of a ZIP.
 *
 * An APK is a ZIP, and the only entry needed here is the manifest, so this is the smallest
 * reader that can honestly claim to work: find the end-of-directory record, walk the central
 * directory, and inflate the one entry asked for. Written rather than depended on because
 * the whole point of this half of the file is that reading an APK costs a stranger nothing.
 *
 * @param {Buffer} zip
 * @param {string} wanted   Exact entry name, e.g. `AndroidManifest.xml`.
 * @returns {Buffer|null}
 */
export function readZipEntry(zip, wanted) {
  // The end-of-directory record is at the very end unless there is a comment, which for an
  // APK there is not; 64k back covers the legal maximum comment anyway.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 66000); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);

    if (name === wanted) {
      if (zip.readUInt32LE(localAt) !== 0x04034b50) return null;
      const localName = zip.readUInt16LE(localAt + 26);
      const localExtra = zip.readUInt16LE(localAt + 28);
      const dataAt = localAt + 30 + localName + localExtra;
      const raw = zip.subarray(dataAt, dataAt + compressed);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) {
        try {
          return zlib.inflateRawSync(raw);
        } catch {
          return null;
        }
      }
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * The android: attributes that matter, by number, for the case where a build tool dropped
 * their names from the string pool.
 *
 * aapt2 keeps the names, so this is a fallback rather than the main path — but some
 * obfuscators and some older toolchains do not, and an adapter that reported "this APK
 * declares no activities" because of that would be lying rather than failing.
 *
 * @type {Record<number, string>}
 */
const ANDROID_ATTRS = {
  0x01010000: 'theme',
  0x01010001: 'label',
  0x01010003: 'name',
  0x01010006: 'permission',
  0x0101000e: 'enabled',
  0x0101000f: 'debuggable',
  0x01010010: 'exported',
  0x01010011: 'process',
  0x01010018: 'authorities',
  0x0101001e: 'value',
  0x01010020: 'resource',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x01010270: 'targetSdkVersion',
  0x010103f6: 'usesCleartextTraffic',
};

/**
 * Read Android's binary XML.
 *
 * The format is a list of chunks: a string pool, an optional map from string index to
 * resource id, then start and end tags carrying attributes. Everything is little-endian and
 * everything is padded to four bytes. What comes back is a plain tree, which is all anything
 * here needs.
 *
 * @param {Buffer} buf
 * @returns {{name: string, attrs: Record<string, string|number|boolean>, children: any[]}|null}
 */
export function parseBinaryXml(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) return null;

  /** @type {string[]} */
  let pool = [];
  /** @type {number[]} */
  let resourceMap = [];

  /**
   * @param {number} at
   * @returns {string[]}
   */
  const readStringPool = (at) => {
    const headerSize = buf.readUInt16LE(at + 2);
    const count = buf.readUInt32LE(at + 8);
    const flags = buf.readUInt32LE(at + 16);
    const stringsStart = buf.readUInt32LE(at + 20);
    const utf8 = (flags & (1 << 8)) !== 0;
    /** @type {string[]} */
    const strings = [];
    for (let i = 0; i < count; i += 1) {
      const offset = at + stringsStart + buf.readUInt32LE(at + headerSize + i * 4);
      if (offset >= buf.length) {
        strings.push('');
        continue;
      }
      if (utf8) {
        // Two lengths, characters then bytes, each one or two bytes depending on the top bit.
        let p = offset;
        const skip = (/** @type {number} */ q) => (buf[q] & 0x80 ? 2 : 1);
        p += skip(p);
        const byteLenAt = p;
        const byteLen = buf[byteLenAt] & 0x80 ? ((buf[byteLenAt] & 0x7f) << 8) | buf[byteLenAt + 1] : buf[byteLenAt];
        p += skip(byteLenAt);
        strings.push(buf.toString('utf8', p, p + byteLen));
      } else {
        const chars = buf[offset] & 0x80 ? (((buf[offset] & 0x7f) << 8) | buf[offset + 1]) : buf.readUInt16LE(offset);
        const p = offset + (buf[offset] & 0x80 ? 4 : 2);
        strings.push(buf.toString('utf16le', p, p + chars * 2));
      }
    }
    return strings;
  };

  /** @param {number} index */
  const str = (index) => (index >= 0 && index < pool.length ? pool[index] : '');

  /** @type {{name: string, attrs: Record<string, string|number|boolean>, children: any[]}|null} */
  let root = null;
  /** @type {{name: string, attrs: Record<string, string|number|boolean>, children: any[]}[]} */
  const stack = [];

  let at = buf.readUInt16LE(2); // past the file header
  while (at + 8 <= buf.length) {
    const type = buf.readUInt16LE(at);
    const size = buf.readUInt32LE(at + 4);
    if (size < 8 || at + size > buf.length) break;

    if (type === 0x0001) {
      pool = readStringPool(at);
    } else if (type === 0x0180) {
      const headerSize = buf.readUInt16LE(at + 2);
      resourceMap = [];
      for (let p = at + headerSize; p + 4 <= at + size; p += 4) resourceMap.push(buf.readUInt32LE(p));
    } else if (type === 0x0102) {
      // The tag's own fields sit in a second header that begins 16 bytes in, and every
      // offset below is counted from THERE rather than from the start of the chunk. Getting
      // that wrong reads the right number of attributes out of the wrong place and hands
      // back a manifest full of empty strings, which looks like an app that declares nothing.
      const nameIndex = buf.readUInt32LE(at + 20);
      const attrStart = buf.readUInt16LE(at + 24);
      const attrSize = buf.readUInt16LE(at + 26);
      const attrCount = buf.readUInt16LE(at + 28);
      /** @type {Record<string, string|number|boolean>} */
      const attrs = {};
      for (let i = 0; i < attrCount; i += 1) {
        const a = at + 16 + attrStart + i * attrSize;
        if (a + 20 > buf.length) break;
        const attrNameIndex = buf.readUInt32LE(a + 4);
        const rawValueIndex = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        let key = str(attrNameIndex);
        if (key === '' && attrNameIndex < resourceMap.length) key = ANDROID_ATTRS[resourceMap[attrNameIndex]] ?? `attr:0x${resourceMap[attrNameIndex].toString(16)}`;
        if (key === '') key = `attr:${attrNameIndex}`;

        /** @type {string|number|boolean} */
        let value;
        if (dataType === 0x03) value = str(rawValueIndex === 0xffffffff ? data : rawValueIndex);
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x10) value = data | 0;
        else if (dataType === 0x11) value = `0x${data.toString(16)}`;
        else if (dataType === 0x01) value = `@${data.toString(16)}`; // a reference into resources
        else value = rawValueIndex !== 0xffffffff && str(rawValueIndex) !== '' ? str(rawValueIndex) : data;
        attrs[key] = value;
      }
      const node = { name: str(nameIndex), attrs, children: /** @type {any[]} */ ([]) };
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else root = node;
      stack.push(node);
    } else if (type === 0x0103) {
      stack.pop();
    }
    at += size;
  }
  return root;
}

/**
 * @typedef {object} ApkComponent
 * @property {'activity'|'service'|'receiver'|'provider'} kind
 * @property {string} name        Fully qualified, with a leading dot expanded.
 * @property {boolean} exported   True when another app can reach it. This is the security
 *                                surface, and a component that quietly became exported is
 *                                exactly the kind of change nobody notices.
 * @property {string|null} permission
 * @property {string[]} actions   Intent actions it answers to.
 * @property {string[]} categories
 * @property {boolean} launcher   True for the one the home screen opens.
 */

/**
 * @typedef {object} ApkFacts
 * @property {boolean} ok
 * @property {string} why
 * @property {string} pkg
 * @property {string|null} versionName
 * @property {number|null} versionCode
 * @property {number|null} minSdk
 * @property {number|null} targetSdk
 * @property {boolean} debuggable
 * @property {boolean} cleartext   Whether it is allowed to talk plain HTTP. Decides whether
 *                                 a proxy can read anything at all beyond the address.
 * @property {string[]} permissions
 * @property {ApkComponent[]} components
 * @property {string|null} launchActivity
 * @property {string} sha256
 * @property {number} bytes
 */

/**
 * Everything an APK will tell you before it is installed.
 *
 * This is the contract channel for Android, and it is worth being clear about how much it
 * is: every permission the app asks for, every activity, service, broadcast receiver and
 * content provider it declares, which of those any other app on the phone can reach, and
 * which intents each one answers. A walkthrough sees the two screens somebody remembered to
 * open. This sees every door.
 *
 * @param {string} apkPath
 * @returns {Promise<ApkFacts>}
 */
export async function readApk(apkPath) {
  /** @type {ApkFacts} */
  const blank = {
    ok: false, why: '', pkg: '', versionName: null, versionCode: null, minSdk: null, targetSdk: null,
    debuggable: false, cleartext: false, permissions: [], components: [], launchActivity: null, sha256: '', bytes: 0,
  };
  /** @type {Buffer} */
  let zip;
  try {
    zip = await fsp.readFile(apkPath);
  } catch (error) {
    return { ...blank, why: `The APK at ${apkPath} could not be read: ${/** @type {Error} */ (error).message}` };
  }
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(zip).digest('hex');

  const manifest = readZipEntry(zip, 'AndroidManifest.xml');
  if (!manifest) return { ...blank, sha256, bytes: zip.length, why: 'This file does not contain an AndroidManifest.xml, so it is not an APK.' };
  const tree = parseBinaryXml(manifest);
  if (!tree || tree.name !== 'manifest') {
    return { ...blank, sha256, bytes: zip.length, why: 'The manifest inside this APK is not in a shape this can read.' };
  }

  const pkg = String(tree.attrs.package ?? '');
  /** @type {string[]} */
  const permissions = [];
  /** @type {ApkComponent[]} */
  const components = [];
  let minSdk = /** @type {number|null} */ (null);
  let targetSdk = /** @type {number|null} */ (null);
  let debuggable = false;
  let cleartext = false;
  let launchActivity = /** @type {string|null} */ (null);

  /** @param {string} name */
  const expand = (name) => (name.startsWith('.') ? `${pkg}${name}` : name.includes('.') ? name : `${pkg}.${name}`);

  for (const child of tree.children) {
    if (child.name === 'uses-permission' || child.name === 'uses-permission-sdk-23') {
      if (child.attrs.name) permissions.push(String(child.attrs.name));
    } else if (child.name === 'uses-sdk') {
      if (child.attrs.minSdkVersion !== undefined) minSdk = Number(child.attrs.minSdkVersion) || null;
      if (child.attrs.targetSdkVersion !== undefined) targetSdk = Number(child.attrs.targetSdkVersion) || null;
    } else if (child.name === 'application') {
      debuggable = child.attrs.debuggable === true;
      cleartext = child.attrs.usesCleartextTraffic === true;
      for (const part of child.children) {
        /** @type {ApkComponent['kind']|null} */
        const kind = part.name === 'activity' || part.name === 'activity-alias' ? 'activity'
          : part.name === 'service' ? 'service'
          : part.name === 'receiver' ? 'receiver'
          : part.name === 'provider' ? 'provider'
          : null;
        if (!kind) continue;
        /** @type {string[]} */
        const actions = [];
        /** @type {string[]} */
        const categories = [];
        for (const filter of part.children) {
          if (filter.name !== 'intent-filter') continue;
          for (const entry of filter.children) {
            if (entry.name === 'action' && entry.attrs.name) actions.push(String(entry.attrs.name));
            if (entry.name === 'category' && entry.attrs.name) categories.push(String(entry.attrs.name));
          }
        }
        const launcher = actions.includes('android.intent.action.MAIN') && categories.includes('android.intent.category.LAUNCHER');
        const name = expand(String(part.attrs.name ?? part.attrs.targetActivity ?? ''));
        // A component with an intent filter is reachable by default; without one it is not.
        const exported = part.attrs.exported === true || (part.attrs.exported === undefined && actions.length > 0);
        components.push({ kind, name, exported, permission: part.attrs.permission ? String(part.attrs.permission) : null, actions, categories, launcher });
        if (launcher && !launchActivity) launchActivity = name;
      }
    }
  }

  return {
    ok: pkg !== '',
    why: pkg !== ''
      ? `${pkg} — ${components.length} component${components.length === 1 ? '' : 's'} and ${permissions.length} permission${permissions.length === 1 ? '' : 's'}, read straight out of the APK without installing it or needing Java.`
      : 'The manifest in this APK has no package name.',
    pkg,
    versionName: tree.attrs.versionName !== undefined ? String(tree.attrs.versionName) : null,
    versionCode: tree.attrs.versionCode !== undefined ? Number(tree.attrs.versionCode) || null : null,
    minSdk,
    targetSdk,
    debuggable,
    cleartext,
    permissions: [...new Set(permissions)].sort(),
    components: components.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)),
    launchActivity,
    sha256,
    bytes: zip.length,
  };
}

// ---------------------------------------------------------------------------
// Holding the device still
// ---------------------------------------------------------------------------

/**
 * The settings that make one run look like the next.
 *
 * Every one of these is a thing that would otherwise differ between two runs and show up as
 * a difference the tool would then have to explain away. Animations are the loudest by far:
 * with them on, a screen read a fraction of a second after a tap is halfway through a fade
 * and half its controls are not there yet, which reports as controls appearing and vanishing
 * — the very worst kind of difference, and pure noise.
 *
 * `key` is what `settings put` is given; `where` is which of the three settings tables it
 * lives in. They are not interchangeable and putting one in the wrong table silently does
 * nothing, which is the failure that looks like the setting simply did not help.
 *
 * @type {{where: 'global'|'system'|'secure', key: string, value: string, why: string}[]}
 */
export const STILLNESS = [
  { where: 'global', key: 'window_animation_scale', value: '0', why: 'windows appearing and disappearing instantly instead of fading' },
  { where: 'global', key: 'transition_animation_scale', value: '0', why: 'screens replacing each other instantly instead of sliding' },
  { where: 'global', key: 'animator_duration_scale', value: '0', why: 'controls inside a screen not animating' },
  { where: 'global', key: 'always_finish_activities', value: '0', why: 'screens not being destroyed the moment you leave them' },
  { where: 'system', key: 'font_scale', value: '1.0', why: 'text the same size every run, so what fits on screen never changes' },
  { where: 'system', key: 'screen_off_timeout', value: '1800000', why: 'the screen never going dark in the middle of a walkthrough' },
  { where: 'system', key: 'accelerometer_rotation', value: '0', why: 'the screen never rotating on its own' },
  { where: 'secure', key: 'immersive_mode_confirmations', value: 'confirmed', why: 'no first-time full-screen prompt covering the app' },
  { where: 'secure', key: 'spell_checker_enabled', value: '0', why: 'no red underlines appearing under typed text' },
  { where: 'secure', key: 'show_ime_with_hard_keyboard', value: '0', why: 'the on-screen keyboard not covering half the screen' },
];

/**
 * @typedef {object} Stillness
 * @property {string[]} pinned    What was fixed, in plain English.
 * @property {string[]} couldNot  What could not be fixed, in plain English. Honesty channel.
 * @property {string} timezone
 * @property {string} locale
 * @property {string|null} clock  What the device clock was set to, when it could be set.
 */

/**
 * Fix everything about the device that would otherwise wobble.
 *
 * The clock is the one that needs root, and on a Play Store system image root is refused
 * forever — so a device that cannot have its clock stopped says so here rather than quietly
 * producing a timestamp difference on every run for the rest of its life.
 *
 * @param {Device} device
 * @param {{clock?: string, timezone?: string, locale?: string}} want
 * @returns {Promise<Stillness>}
 */
export async function holdStill(device, want) {
  /** @type {string[]} */
  const pinned = [];
  /** @type {string[]} */
  const couldNot = [];

  for (const setting of STILLNESS) {
    const put = await device.shell(`settings put ${setting.where} ${setting.key} ${setting.value}`, { timeoutMs: 20000 });
    const read = await device.shell(`settings get ${setting.where} ${setting.key}`, { timeoutMs: 20000 });
    if (put.ok && read.out.trim() === setting.value) pinned.push(setting.why);
    else couldNot.push(`${setting.why} — the device would not accept ${setting.key}`);
  }

  const timezone = want.timezone ?? 'UTC';
  const setZone = await device.shell(`service call alarm 3 s16 ${timezone}`, { timeoutMs: 20000 });
  const zoneNow = (await device.shell('getprop persist.sys.timezone', { timeoutMs: 15000 })).out.trim();
  if (zoneNow === timezone) pinned.push(`the clock reading ${timezone} rather than wherever this machine happens to be`);
  else couldNot.push(`the time zone is ${zoneNow || 'unknown'} and would not move to ${timezone}${setZone.err ? ` (${setZone.err.trim()})` : ''}`);

  const locale = want.locale ?? (await device.shell('getprop persist.sys.locale', { timeoutMs: 15000 })).out.trim() ?? 'en-US';

  /** @type {string|null} */
  let clock = null;
  if (want.clock) {
    const rooted = await device.root();
    if (!rooted) {
      couldNot.push('the date and time could not be frozen: this device refuses root, which a Play Store system image always does. Anything the app shows with a date in it will differ between runs and be treated as the product\'s own wobble.');
    } else {
      // Android's `date` is toybox, and it takes either MMDDhhmm or an epoch with an @ on
      // the front. It does NOT take an ISO timestamp, and it fails with "bad date" rather
      // than doing anything, which is easy to miss and leaves every run on a different clock.
      const seconds = Math.floor(new Date(want.clock).getTime() / 1000);
      await device.shell('settings put global auto_time 0', { timeoutMs: 20000 });
      const set = await device.shell(`date -u @${seconds}`, { timeoutMs: 20000 });
      if (set.ok && !/bad date/i.test(set.out + set.err)) {
        clock = want.clock;
        pinned.push(`the device believing it is ${want.clock}`);
      } else {
        couldNot.push(`the date could not be set to ${want.clock}: ${set.err.trim() || 'the device refused'}`);
      }
    }
  }

  // A device that thinks it has no internet keeps showing a warning triangle and keeps
  // retrying in the background, both of which move. Better to leave the network up and stop
  // the traffic at the proxy, where it can also be written down.
  await device.shell('input keyevent KEYCODE_WAKEUP', { timeoutMs: 15000 });
  await device.shell('wm dismiss-keyguard', { timeoutMs: 15000 });

  return { pinned, couldNot, timezone: zoneNow || timezone, locale, clock };
}

// ---------------------------------------------------------------------------
// Reading the screen — meaning, never markup
// ---------------------------------------------------------------------------

/**
 * One thing on screen, as the accessibility layer describes it.
 *
 * @typedef {object} Node
 * @property {string} kind       The widget class, short: `Button`, `EditText`, `TextView`.
 * @property {string} id         The resource id, without the package on the front.
 * @property {string} name       What a screen reader would say: the description, or the text.
 * @property {string} text
 * @property {string} desc
 * @property {boolean} enabled
 * @property {boolean} checkable
 * @property {boolean} checked
 * @property {boolean} clickable
 * @property {boolean} focused
 * @property {boolean} scrollable
 * @property {boolean} password
 * @property {boolean} selected
 * @property {string} pkg
 * @property {[number, number, number, number]} bounds  Only ever used to press it. Never stored.
 * @property {string} address    The stable address this node is filed under.
 * @property {number} depth
 */

/** Widgets that are furniture: they carry no meaning of their own and only add noise. */
const FURNITURE = new Set(['FrameLayout', 'LinearLayout', 'RelativeLayout', 'ViewGroup', 'View', 'ScrollView', 'ConstraintLayout', 'CoordinatorLayout', 'NestedScrollView', 'RecyclerView', 'ListView']);

/**
 * @param {string} value
 * @returns {string}
 */
function tidy(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Turn the accessibility dump into a flat list with a stable address on each entry.
 *
 * The address is the whole design of this file in one function. It is built out of what a
 * control IS, in this order:
 *
 *   1. Its resource id. A developer put that there deliberately and it survives everything.
 *   2. What a screen reader would call it — the content description.
 *   3. Its own text.
 *   4. Its kind plus which one it is among its siblings of the same kind.
 *
 * Nothing about where it is on screen goes in. Two runs on the same device would agree about
 * coordinates, but a font-scale change, a longer translation or an open keyboard would not,
 * and an address that moves is an address that reports a false difference. Falling all the
 * way through to `Button#2` is the honest bottom of the ladder: it says the tool is counting
 * rather than recognising, and that is worth knowing when a finding comes from one.
 *
 * @param {string} xml
 * @param {{pkg?: string, keepFurniture?: boolean}} [opts]
 * @returns {Node[]}
 */
export function readTree(xml, opts = {}) {
  /** @type {Node[]} */
  const nodes = [];
  /** @type {{path: string, counts: Map<string, number>}[]} */
  const stack = [];
  const tokens = String(xml).matchAll(/<(\/?)(hierarchy|node)\b([^>]*?)(\/?)>/g);

  for (const token of tokens) {
    const closing = token[1] === '/';
    const tag = token[2];
    const attrText = token[3] ?? '';
    const selfClosing = token[4] === '/';

    if (tag === 'hierarchy') {
      if (!closing) stack.push({ path: '', counts: new Map() });
      else stack.pop();
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }

    /** @type {Record<string, string>} */
    const attrs = {};
    for (const pair of attrText.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[pair[1]] = pair[2];

    const kind = (attrs.class ?? '').split('.').pop() ?? '';
    const rawId = attrs['resource-id'] ?? '';
    const id = rawId.includes('/') ? rawId.split('/')[1] : rawId;
    const text = tidy(attrs.text);
    const desc = tidy(attrs['content-desc']);
    const parent = stack[stack.length - 1] ?? { path: '', counts: new Map() };

    // Whether this thing can be operated decides whether its own words are allowed to
    // identify it. A button's label IS what the button is, and naming it by its label is
    // what makes the address survive a redesign. A paragraph's words are DATA — they are
    // the very thing a change is likely to alter — so naming a paragraph by its words would
    // turn every edited sentence into a control that vanished and another that appeared,
    // which is the loudest and least useful difference this tool can report.
    const operable = attrs.clickable === 'true' || attrs.checkable === 'true' || attrs['long-clickable'] === 'true'
      || attrs.focusable === 'true' || attrs.scrollable === 'true' || kind === 'EditText';

    /** @type {string} */
    let own;
    if (id !== '') own = `${kind}:${id}`;
    else if (desc !== '') own = `${kind}:${desc}`;
    else if (operable && text !== '' && text.length <= 64) own = `${kind}:${text}`;
    else {
      const seen = (parent.counts.get(kind) ?? 0) + 1;
      parent.counts.set(kind, seen);
      own = `${kind}#${seen}`;
    }
    // Only an ancestor that is something in its own right — one with an id, a description or
    // an operable label — becomes part of the address. Wrapping a screen in one more layout
    // to fix its spacing is a restyle, and a restyle must report nothing at all.
    const named = id !== '' || desc !== '' || (operable && text !== '');
    const address = parent.path === '' ? own : `${parent.path}/${own}`;

    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    /** @type {Node} */
    const node = {
      kind,
      id,
      name: desc || text,
      text,
      desc,
      enabled: attrs.enabled === 'true',
      checkable: attrs.checkable === 'true',
      checked: attrs.checked === 'true',
      clickable: attrs.clickable === 'true',
      focused: attrs.focused === 'true',
      scrollable: attrs.scrollable === 'true',
      password: attrs.password === 'true',
      selected: attrs.selected === 'true',
      pkg: attrs.package ?? '',
      bounds: bounds
        ? [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])]
        : [0, 0, 0, 0],
      address,
      depth: stack.length,
    };

    const wanted = (!opts.pkg || node.pkg === opts.pkg) && (opts.keepFurniture || !FURNITURE.has(kind) || node.clickable || node.scrollable);
    if (wanted) nodes.push(node);
    if (!selfClosing) stack.push({ path: named ? address : parent.path, counts: parent.counts });
  }
  return nodes;
}

/**
 * Ask the device what is on screen.
 *
 * The dump is written to the device and read back rather than taken off the command's own
 * output, because `uiautomator dump` prints a line of its own first and some builds of it
 * mangle the XML on the way through the shell. Two attempts, because the dumper genuinely
 * does fail with "could not get idle state" when something on screen is still moving — which
 * is worth one retry and is worth reporting if it survives one.
 *
 * @param {Device} device
 * @returns {Promise<{ok: boolean, xml: string, why: string}>}
 */
export async function dumpScreen(device) {
  const remote = '/data/local/tmp/staysfixed-screen.xml';
  /** @type {string} */
  let why = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const dumped = await device.shell(`uiautomator dump --compressed ${remote}`, { timeoutMs: 60000 });
    if (/dumped to/i.test(dumped.out)) {
      const read = await device.shell(`cat ${remote}`, { timeoutMs: 60000 });
      if (read.out.includes('<hierarchy')) return { ok: true, xml: read.out, why: 'read what is on screen' };
      why = 'the screen was dumped but came back empty';
    } else {
      why = tidy(dumped.out || dumped.err) || 'the device would not dump what is on screen';
    }
    await pause(1200, device.signal);
  }
  return { ok: false, xml: '', why };
}

/**
 * Wait until the screen stops changing.
 *
 * The same idea as `settle` in the freeze layer and for the same reason: reading a screen
 * that is still moving is the single biggest source of false differences on a phone. Two
 * identical dumps in a row is the signal. If it never settles, that is said out loud rather
 * than papered over — a screen that will not sit still is itself a finding.
 *
 * @param {Device} device
 * @param {{tries?: number, gapMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, xml: string, tries: number, settled: boolean, why: string}>}
 */
export async function settleScreen(device, opts = {}) {
  const tries = opts.tries ?? 6;
  const gap = opts.gapMs ?? 400;
  let previous = '';
  let last = { ok: false, xml: '', why: 'nothing was read' };
  for (let i = 0; i < tries; i += 1) {
    last = await dumpScreen(device);
    if (!last.ok) return { ...last, tries: i + 1, settled: false };
    const shape = readTree(last.xml).map((n) => `${n.address}|${n.text}|${n.enabled}|${n.checked}`).join('\n');
    if (shape === previous) return { ok: true, xml: last.xml, tries: i + 1, settled: true, why: 'the screen stopped changing' };
    previous = shape;
    await pause(gap, device.signal);
  }
  return { ok: last.ok, xml: last.xml, tries, settled: false, why: `the screen was still changing after ${tries} looks, so what follows may be halfway through something` };
}

// ---------------------------------------------------------------------------
// Pressing things — found by identifier, pressed by whatever coordinate it has today
// ---------------------------------------------------------------------------

/**
 * Find one control by what it is.
 *
 * Accepts any of the four ways of naming a thing and tries them in the order that puts the
 * most deliberate first. Returns every match, so a caller can refuse to act when a name
 * turns out to mean two things — pressing the first of two identical buttons is how a
 * walkthrough silently starts doing something different from what it did last time.
 *
 * @param {Node[]} nodes
 * @param {{id?: string, name?: string, text?: string, kind?: string, address?: string}} want
 * @returns {Node[]}
 */
export function findNodes(nodes, want) {
  return nodes.filter((node) => {
    if (want.address !== undefined && node.address !== want.address) return false;
    if (want.id !== undefined && node.id !== want.id) return false;
    if (want.name !== undefined && node.name.toLowerCase() !== want.name.toLowerCase()) return false;
    if (want.text !== undefined && node.text.toLowerCase() !== want.text.toLowerCase()) return false;
    if (want.kind !== undefined && node.kind !== want.kind) return false;
    return want.address !== undefined || want.id !== undefined || want.name !== undefined || want.text !== undefined || want.kind !== undefined;
  });
}

/**
 * Press one control, having found it by name.
 *
 * The middle of whatever the tree says its edges are right now — worked out on this run, for
 * this device, at this font size, and thrown away immediately afterwards.
 *
 * @param {Device} device
 * @param {Node} node
 * @returns {Promise<Ran>}
 */
export function pressNode(device, node) {
  const [left, top, right, bottom] = node.bounds;
  return device.shell(`input tap ${Math.round((left + right) / 2)} ${Math.round((top + bottom) / 2)}`, { timeoutMs: 30000 });
}

/**
 * Type into whatever has the cursor.
 *
 * `input text` cannot carry a space or several kinds of punctuation through the shell, so
 * the text is sent in pieces with explicit space keys between them. Anything outside plain
 * ASCII is refused rather than mangled, because half-typed text looks exactly like a bug in
 * the app.
 *
 * @param {Device} device
 * @param {string} text
 * @returns {Promise<{ok: boolean, why: string}>}
 */
export async function typeText(device, text) {
  if (/[^\x20-\x7e]/.test(text)) {
    return { ok: false, why: 'that text has characters the device keyboard cannot be told to type, so nothing was typed rather than typing something slightly different' };
  }
  const words = text.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== '') {
      const safe = words[i].replace(/(["'`\\$&|;<>()*?~^#])/g, '\\$1');
      const typed = await device.shell(`input text ${safe}`, { timeoutMs: 30000 });
      if (!typed.ok) return { ok: false, why: `the device would not type "${words[i]}"` };
    }
    if (i < words.length - 1) await device.shell('input keyevent KEYCODE_SPACE', { timeoutMs: 20000 });
  }
  return { ok: true, why: `typed ${text.length} characters` };
}

// ---------------------------------------------------------------------------
// What went out — the wire
// ---------------------------------------------------------------------------

/**
 * One call the device tried to make.
 *
 * @typedef {object} Call
 * @property {'plain'|'encrypted'} how   `encrypted` means all that was seen is the host and
 *                                       the port: the request itself was inside TLS and was
 *                                       never opened. That is the honest limit of a proxy
 *                                       and it is recorded rather than glossed over.
 * @property {string} method
 * @property {string} host
 * @property {number} port
 * @property {string} route             The address with the changing parts taken out.
 * @property {boolean} allowed
 * @property {string} why
 */

/**
 * @typedef {object} Wire
 * @property {number} port
 * @property {Call[]} calls
 * @property {() => Promise<Call[]>} stop
 */

/**
 * Take the changing parts out of an address.
 *
 * A call to `/api/notes/8f2c1` and a call to `/api/notes/91aa4` are the same call, and
 * reporting them as different is how a tool teaches somebody to ignore it.
 *
 * @param {string} url
 * @returns {string}
 */
export function shapeOfUrl(url) {
  const withoutQuery = String(url).split('?')[0];
  return withoutQuery
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/<an id>')
    .replace(/\/\d+(?=\/|$)/g, '/<a number>')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(?=\/|$)/gi, '/<an id>');
}

/**
 * Whether a call is one this tool must never let happen.
 *
 * Deliberately blunt, and deliberately erring towards refusing. The cost of refusing a
 * harmless call is one line in the report saying it was not checked; the cost of allowing a
 * real one is somebody's money.
 *
 * @param {string} method
 * @param {string} url
 * @returns {{safe: boolean, why: string}}
 */
export function looksIrreversible(method, url) {
  const target = String(url).toLowerCase();
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
  const money = /\b(pay|payment|charge|checkout|billing|invoice|subscribe|refund|purchase|order|stripe|paypal|braintree|adyen)\b/.test(target);
  const message = /\b(sms|email|mail|notify|notification|push|message|send|twilio|sendgrid|whatsapp|telegram)\b/.test(target);
  const destroying = /\b(delete|remove|destroy|drop|wipe|purge|deactivate|cancel)\b/.test(target);
  if (money) return { safe: false, why: 'this looks like it spends money' };
  if (message) return { safe: false, why: 'this looks like it sends a message to somebody' };
  if (writing && destroying) return { safe: false, why: 'this looks like it destroys data' };
  return { safe: true, why: '' };
}

/**
 * Hosts that belong to the phone rather than to the app.
 *
 * A device-wide proxy cannot tell which process made a call — it sees a socket, not a
 * program — so calls are attributed by who they are to. Everything Google's own services do
 * in the background is filed separately, and this limit is stated in the adapter's own
 * description rather than hidden here.
 */
/*
 * Every one of these was seen leaving a Google APIs emulator on 2026-08-30 while Terminal
 * Deck — an app that talks to one relay and nothing else — sat on its first screen. The
 * ones added that day are on the second line: `googleadservices` and `youtube` were being
 * filed as calls THE APP made, which reads as "your change made the app phone YouTube" and
 * is the most alarming false alarm this adapter is capable of producing.
 */
const DEVICE_HOSTS = /(^|\.)(google|googleapis|gstatic|android|gvt1|gvt2|doubleclick|crashlytics|firebaseinstallations)\.com$|(^|\.)(googleadservices|googlesyndication|googletagmanager|googleusercontent|google-analytics|youtube|ytimg|ggpht|appspot)\.com$|(^|\.)google\.[a-z.]+$/i;

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isDeviceHost(host) {
  return DEVICE_HOSTS.test(String(host).split(':')[0]);
}

/**
 * Watch every call the device makes, and stop the ones that must not happen.
 *
 * A proxy on this machine, pointed at by the device's own proxy setting, is the practical
 * answer on Android: it needs no certificate, no root, and no change to the app. What it
 * buys is the whole of the effects channel — every address the app reaches for, in order,
 * with the method — and what it costs is the inside of anything encrypted, which stays shut.
 * That is exactly the "observed at the call boundary, refused at the effect" line the design
 * draws, and it is drawn here rather than argued about.
 *
 * By default NOTHING is forwarded. The device is talking to a wall that writes everything
 * down, which also removes the largest single source of wobble on a phone: the real internet.
 *
 * @param {{allowTo?: string[], log?: (m: string) => void}} [opts]
 * @returns {Promise<Wire>}
 */
export async function watchTheWire(opts = {}) {
  /** @type {Call[]} */
  const calls = [];
  const allow = new Set((opts.allowTo ?? []).map((h) => h.toLowerCase()));

  /**
   * @param {string} host
   * @param {number} port
   * @param {string} method
   * @param {string} route
   * @param {'plain'|'encrypted'} how
   * @returns {Call}
   */
  const record = (host, port, method, route, how) => {
    const verdict = looksIrreversible(method, `${host}${route}`);
    const allowed = allow.has(host.toLowerCase()) && verdict.safe;
    const call = {
      how, method, host, port, route,
      allowed,
      why: allowed
        ? 'let through, because this project said this address is its own'
        : verdict.safe
        ? 'written down and stopped here: nothing this run does is allowed off this machine'
        : `written down and stopped here: ${verdict.why}`,
    };
    calls.push(call);
    opts.log?.(`the app called ${method} ${host}${route} — ${call.why}`);
    return call;
  };

  const server = http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://unknown');
    } catch {
      url = new URL('http://unknown/');
    }
    record(url.hostname, Number(url.port) || 80, request.method ?? 'GET', shapeOfUrl(url.pathname), 'plain');
    // A refusal has to look like a refusal from the network, not like a working server
    // answering oddly, or the app under test takes a different path than it would in life.
    response.writeHead(503, { 'content-type': 'text/plain', 'x-stays-fixed': 'stopped here on purpose' });
    response.end('This call was written down and stopped by Stays Fixed. Nothing left this machine.\n');
  });

  server.on('connect', (request, socket) => {
    const [host, port] = String(request.url ?? '').split(':');
    record(host, Number(port) || 443, 'CONNECT', '/<inside TLS, never opened>', 'encrypted');
    socket.end('HTTP/1.1 502 Bad Gateway\r\nX-Stays-Fixed: stopped here on purpose\r\n\r\n');
  });

  // Anything that reaches the port without speaking HTTP is hung up on rather than left open.
  server.on('clientError', (_error, socket) => {
    if (socket instanceof net.Socket && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    port,
    calls,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(calls));
      }),
  };
}

/**
 * The address the emulator reaches this machine on. Not localhost — inside the emulator that
 * is the emulator.
 */
export const HOST_FROM_EMULATOR = '10.0.2.2';

// ---------------------------------------------------------------------------
// What went out — files, permissions, intents
// ---------------------------------------------------------------------------

/**
 * Every file the app has written, with its size.
 *
 * Contents are not read. A file's name and rough size is what changes when behaviour
 * changes; its contents are usually a timestamp away from differing on every run, and
 * reading them all off a device is slow enough to matter.
 *
 * Two ways in, and which one worked is reported, because they see different amounts. With
 * root, everything under the app's folder. Without root, `run-as` sees the same folder but
 * only for an app built as debuggable — and a release APK on a Play Store image can be seen
 * neither way, which is missing coverage and is said so.
 *
 * @param {Device} device
 * @param {string} pkg
 * @returns {Promise<{ok: boolean, how: string, why: string, files: {path: string, bytes: string}[]}>}
 */
export async function filesWritten(device, pkg) {
  const find = `find /data/data/${pkg} -type f -not -path '*/cache/*' -exec stat -c '%s %n' {} + 2>/dev/null | head -400`;

  /** @param {string} out */
  const parse = (out) =>
    out
      .split('\n')
      .map((line) => tidy(line))
      .filter((line) => line !== '')
      .map((line) => {
        const at = line.indexOf(' ');
        const bytes = Number(line.slice(0, at));
        return {
          path: line.slice(at + 1).replace(`/data/data/${pkg}/`, ''),
          // Bucketed, because a database file that grew by 12 bytes is not news and would
          // otherwise differ on every single run.
          bytes: bytes < 1024 ? 'under a kilobyte' : bytes < 102400 ? 'kilobytes' : bytes < 10485760 ? 'megabytes' : 'tens of megabytes or more',
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));

  if (await device.root()) {
    const asked = await device.shell(find, { timeoutMs: 60000 });
    if (asked.ok) return { ok: true, how: 'as root', why: 'every file the app has written was listed', files: parse(asked.out) };
  }
  const viaRunAs = await device.shell(`run-as ${pkg} sh -c "${find.replace(/"/g, '\\"')}"`, { timeoutMs: 60000 });
  if (viaRunAs.ok && !/not debuggable|unknown package|Could not/i.test(viaRunAs.out + viaRunAs.err)) {
    return { ok: true, how: 'through the app itself', why: 'the files were listed by asking the app, which only works because it is a debuggable build', files: parse(viaRunAs.out) };
  }
  return {
    ok: false,
    how: 'not at all',
    why: 'the files this app writes cannot be seen: this device refuses root and the app is not a debuggable build. Anything it saves is therefore unchecked, not unchanged.',
    files: [],
  };
}

/**
 * Which permissions the app has actually been granted, as opposed to which it asks for.
 *
 * The APK says what it wants; this says what it has. An app that quietly started being
 * granted something is a real change and it is invisible in every other channel.
 *
 * @param {Device} device
 * @param {string} pkg
 * @returns {Promise<{granted: string[], asked: string[]}>}
 */
export async function permissionsHeld(device, pkg) {
  const dump = await device.shell(`dumpsys package ${pkg}`, { timeoutMs: 60000 });
  /** @type {Set<string>} */
  const granted = new Set();
  /** @type {Set<string>} */
  const asked = new Set();
  let section = '';
  for (const raw of dump.out.split('\n')) {
    const line = raw.trim();
    if (/^requested permissions:/i.test(line)) section = 'asked';
    else if (/^(install|runtime) permissions:/i.test(line)) section = 'granted';
    else if (/^[A-Za-z ]+:$/.test(line)) section = '';
    else if (line.startsWith('android.permission') || line.startsWith('com.')) {
      const name = line.split(':')[0].trim();
      if (section === 'asked') asked.add(name);
      if (section === 'granted' && /granted=true/.test(line)) granted.add(name);
      if (section === 'granted' && !line.includes('granted=')) granted.add(name);
    }
  }
  return { granted: [...granted].sort(), asked: [...asked].sort() };
}

/**
 * What logcat said, cut down to this app and sorted into what it means.
 *
 * `--pid` is used where a pid is known, because a package's own tag is not enough: a crash
 * is printed by the runtime under its own tag and would be missed. Timestamps, thread ids
 * and pids are stripped from the text kept, since all three differ on every run and none of
 * them is ever the finding.
 *
 * @param {Device} device
 * @param {{pkg: string, pid?: number, sinceMs?: number}} what
 * @returns {Promise<{crashes: string[], anrs: string[], errors: string[], lines: string[], raw: string}>}
 */
export async function complaints(device, what) {
  const filter = what.pid ? `--pid=${what.pid}` : '';
  const asked = await device.shell(`logcat -d -v brief ${filter}`, { timeoutMs: 60000 });
  /** @type {string[]} */
  const crashes = [];
  /** @type {string[]} */
  const anrs = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const lines = [];

  for (const raw of asked.out.split('\n')) {
    const line = tidy(raw).replace(/\(\s*\d+\s*\)/g, '').replace(/\b\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\b/g, '');
    if (line === '' || line.startsWith('---------')) continue;
    if (!what.pid && !line.includes(what.pkg) && !/AndroidRuntime|ANR in|FATAL/.test(line)) continue;
    lines.push(line);
    if (/FATAL EXCEPTION|AndroidRuntime: .*Exception|signal \d+ \(SIG/.test(line)) crashes.push(line);
    else if (/ANR in|Application Not Responding/.test(line)) anrs.push(line);
    else if (/^E\//.test(line)) errors.push(line);
  }
  return { crashes, anrs, errors, lines, raw: asked.out };
}

/**
 * Every other app or screen this app asked Android to open.
 *
 * Read out of the activity manager's own log lines rather than by hooking anything, so it
 * works on any device and on a release build. It catches a share sheet, a browser, a dialler
 * — the things an app does that leave it entirely, which nothing on screen would ever show.
 *
 * @param {Device} device
 * @param {string} pkg
 * @returns {Promise<string[]>}
 */
export async function intentsFired(device, pkg) {
  const asked = await device.shell('logcat -d -b events -v brief', { timeoutMs: 60000 });
  /** @type {Set<string>} */
  const out = new Set();
  for (const raw of asked.out.split('\n')) {
    if (!raw.includes(pkg)) continue;
    // Android 12 renamed these event tags from `am_` to `wm_` and left the old names in the
    // wild on older devices, so both are read. The component is the fourth field.
    const started = /\b(?:am|wm)_(?:create_activity|activity_launching|new_intent)\s*(?:\(\s*\d+\s*\))?\s*:\s*\[[^,]*,[^,]*,[^,]*,([^,\]]+)/.exec(raw);
    if (started) out.add(tidy(started[1]));
    const explicit = /cmp=([\w.]+\/[\w.$]*)/.exec(raw);
    if (explicit) out.add(tidy(explicit[1]));
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Putting the device back
// ---------------------------------------------------------------------------

/**
 * Save the whole machine, so it can be put back exactly.
 *
 * @param {Device} device
 * @param {string} name
 * @returns {Promise<{ok: boolean, ms: number, why: string}>}
 */
export async function snapshotSave(device, name) {
  const started = Date.now();
  const asked = await device.cmd(['emu', 'avd', 'snapshot', 'save', name], { timeoutMs: 300000 });
  const ok = /\bOK\b/.test(asked.out) && !/KO/.test(asked.out);
  return {
    ok,
    ms: Date.now() - started,
    why: ok ? `the whole device was saved as "${name}"` : `the device would not save a snapshot: ${tidy(asked.out || asked.err) || 'no reason given'}`,
  };
}

/**
 * Put the whole machine back.
 *
 * This is the strong form of resetting between two builds, and it is far stronger than
 * uninstalling: it puts back the settings, the accounts, the clock, the caches and anything
 * the app left anywhere on the device, not only inside its own folder. Where it works, both
 * builds genuinely start from the same machine.
 *
 * @param {Device} device
 * @param {string} name
 * @returns {Promise<{ok: boolean, ms: number, why: string}>}
 */
export async function snapshotLoad(device, name) {
  const started = Date.now();
  const asked = await device.cmd(['emu', 'avd', 'snapshot', 'load', name], { timeoutMs: 300000 });
  const ok = /\bOK\b/.test(asked.out) && !/KO/.test(asked.out);
  if (ok) {
    await device.cmd(['wait-for-device'], { timeoutMs: 120000 });
    // adbd is restarted by the restore, so root has to be asked for again.
    device.rooted = null;
  }
  return {
    ok,
    ms: Date.now() - started,
    why: ok ? `the whole device was put back to "${name}"` : `the device would not restore the snapshot: ${tidy(asked.out || asked.err) || 'no reason given'}`,
  };
}

/**
 * The weaker reset: take the app off and put everything it owned with it.
 *
 * Used when snapshots are not available. It is weaker in a way worth naming: anything the
 * app changed OUTSIDE its own folder — a permission it was granted, a setting it altered, a
 * file it put in shared storage, an account it added — survives this and carries from one
 * build's run into the other's.
 *
 * @param {Device} device
 * @param {string} pkg
 * @returns {Promise<{ok: boolean, why: string}>}
 */
export async function removeApp(device, pkg) {
  await device.shell(`am force-stop ${pkg}`, { timeoutMs: 30000 });
  const gone = await device.cmd(['uninstall', pkg], { timeoutMs: 120000 });
  const wasThere = /Success/i.test(gone.out);
  return {
    ok: true,
    why: wasThere
      ? 'the app and everything inside its own folder were removed'
      : 'the app was not installed, so there was nothing to remove',
  };
}

/**
 * Put an APK on the device.
 *
 * `-g` grants everything the app asks for up front. That is deliberate: a permission prompt
 * appearing halfway through a walkthrough covers the screen, and whether it appears at all
 * depends on what the device remembers from last time — which is the definition of a
 * difference caused by the harness rather than by the change.
 *
 * @param {Device} device
 * @param {string} apkPath
 * @returns {Promise<{ok: boolean, ms: number, why: string}>}
 */
export async function installApk(device, apkPath) {
  const started = Date.now();
  const asked = await device.cmd(['install', '-r', '-g', '-t', apkPath], { timeoutMs: 300000 });
  const ok = /Success/i.test(asked.out);
  return {
    ok,
    ms: Date.now() - started,
    why: ok
      ? 'the app was installed with every permission it asks for already granted, so no prompt can interrupt a walkthrough'
      : `the app would not install: ${tidy(asked.out || asked.err) || 'no reason given'}`,
  };
}

/**
 * The process id of a running app, or null.
 * @param {Device} device
 * @param {string} pkg
 * @returns {Promise<number|null>}
 */
export async function pidOf(device, pkg) {
  const asked = await device.shell(`pidof ${pkg}`, { timeoutMs: 20000 });
  const pid = Number(tidy(asked.out).split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Take a picture. Evidence only — never the accusation.
 * @param {Device} device
 * @param {string} to
 * @returns {Promise<{ok: boolean, bytes: number, path: string}>}
 */
export async function screenshot(device, to) {
  const png = await device.bytes('screencap -p');
  if (png.length < 8 || png[0] !== 0x89) return { ok: false, bytes: png.length, path: to };
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, png);
  return { ok: true, bytes: png.length, path: to };
}

// ---------------------------------------------------------------------------
// Starting an emulator of our own
// ---------------------------------------------------------------------------

/**
 * Ports adb will talk to an emulator on. Even numbers only, 5554 upwards, and adb ignores
 * anything outside this range — a fact that is not written down anywhere obvious and costs
 * an afternoon when an emulator starts perfectly and then cannot be seen.
 */
const EMULATOR_PORTS = Array.from({ length: 16 }, (_, i) => 5554 + i * 2);

/**
 * Which virtual device an already-running emulator is.
 *
 * The serial says nothing about it — `emulator-5554` is a port, not a name — so the emulator
 * has to be asked. This is what stops the tool starting a second copy of a virtual device
 * somebody is already using, which does not work and does not fail cleanly either: the
 * second copy finds the disk locked and sits there never finishing its boot, and all the
 * caller sees is a timeout with no reason attached.
 *
 * @param {string} adb
 * @param {string} serial
 * @param {AbortSignal} [signal]
 * @returns {Promise<string|null>}
 */
export async function avdBehind(adb, serial, signal) {
  const asked = await run(adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 20000, signal });
  const name = asked.out.split('\n').map((l) => l.trim()).find((l) => l !== '' && l !== 'OK');
  return name ?? null;
}

/**
 * Start an emulator this tool owns.
 *
 * The rule this obeys is the one that matters most on somebody else's machine: never touch
 * what they are using. A device that is already running is used as it is and never shut down
 * afterwards; only an emulator started here is ever stopped, and `owned` is how the caller
 * knows which it has. A virtual device that is ALREADY running is handed straight back for
 * the same reason — starting a second copy of one is not something to work around, because
 * the two copies would share one disk and one saved state.
 *
 * @param {object} spec
 * @param {string} spec.emulator      Path to the emulator binary.
 * @param {string} spec.adb
 * @param {string} spec.avd
 * @param {AbortSignal} [spec.signal]
 * @param {(m: string) => void} [spec.log]
 * @param {boolean} [spec.headless]   Default true. A window on somebody's screen is a
 *                                    surprise, and the design says announce any visible
 *                                    automation rather than spring it.
 * @returns {Promise<{ok: boolean, serial: string, owned: boolean, why: string, stop: () => Promise<void>}>}
 */
export async function startEmulator(spec) {
  const running = await listDevices(spec.adb, spec.signal);
  for (const device of running) {
    if (!device.emulator || device.state !== 'device') continue;
    if ((await avdBehind(spec.adb, device.serial, spec.signal)) === spec.avd) {
      return {
        ok: true,
        serial: device.serial,
        owned: false,
        why: `${spec.avd} is already running as ${device.serial}, so it was used as it is and will be left running afterwards`,
        stop: async () => {},
      };
    }
  }

  const taken = new Set(running.map((d) => d.serial));
  const port = EMULATOR_PORTS.find((p) => !taken.has(`emulator-${p}`));
  if (port === undefined) {
    return { ok: false, serial: '', owned: false, why: 'every port an emulator can use is already in use on this machine.', stop: async () => {} };
  }
  const serial = `emulator-${port}`;

  const args = [
    '-avd', spec.avd,
    '-port', String(port),
    '-no-audio',
    '-no-boot-anim',
    // Never write back over the snapshot the machine's owner has: this tool's runs must
    // leave their AVD exactly as they found it.
    '-no-snapshot-save',
    '-gpu', 'swiftshader_indirect',
  ];
  if (spec.headless !== false) args.push('-no-window');

  const child = spawn(spec.emulator, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep the last of whatever it said. When an emulator will not come up, the reason is in
  // here and nowhere else, and a bare "it did not boot in six minutes" sends somebody
  // looking in every wrong place first.
  /** @type {string[]} */
  const said = [];
  /** @param {Buffer} chunk */
  const remember = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const clean = line.trim();
      if (clean !== '' && !/^INFO/.test(clean)) said.push(clean);
    }
    while (said.length > 12) said.shift();
  };
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);
  spec.log?.(`starting the ${spec.avd} emulator as ${serial}`);

  // An emulator that dies on the spot — no disk, a locked virtual device, a bad image —
  // must not cost six minutes of waiting for a boot that is never coming.
  /** @type {Promise<{ready: boolean, ms: number, why: string}>} */
  const died = new Promise((resolve) => {
    child.once('exit', (code) => {
      resolve({ ready: false, ms: 0, why: `the emulator stopped on its own${code === null ? '' : ` (exit code ${code})`} instead of finishing its boot` });
    });
  });

  const device = new Device(spec.adb, serial, { signal: spec.signal, log: spec.log });
  const ready = await Promise.race([device.waitUntilReady(360000), died]);

  const stop = async () => {
    try {
      await run(spec.adb, ['-s', serial, 'emu', 'kill'], { timeoutMs: 30000 });
    } catch {
      // Falling through to the process is fine; the console may already be gone.
    }
    if (!child.killed) child.kill('SIGTERM');
  };

  if (!ready.ready) {
    await stop();
    return {
      ok: false,
      serial,
      owned: true,
      why: `${ready.why}${said.length > 0 ? `. The emulator said: ${said.join(' / ')}` : ''}`,
      stop: async () => {},
    };
  }
  return { ok: true, serial, owned: true, why: `${spec.avd} came up as ${serial} in ${Math.round(ready.ms / 1000)} seconds`, stop };
}
