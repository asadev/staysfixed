/**
 * The probes, held to the one rule doctor is built on: DETECT, NEVER ASSUME.
 *
 * Every case in this file is a wrong answer this tool actually gave about this machine on
 * 2026-08-30, written down with the bytes that caused it. All three were the same shape of
 * mistake — a probe that accepted whatever came back instead of asking a question only the
 * true answer could produce — and all three were invisible, because a machine survey that
 * is confidently wrong looks exactly like one that is right.
 *
 *   1. `ssh github-imza 'echo staysfixed-reachable'` is REFUSED by github.com, and the
 *      refusal quotes the command back: `Invalid command: echo staysfixed-reachable`, on
 *      stderr. A probe reading both streams and looking for the word anywhere found its own
 *      word inside the refusal, and listed a git host among the machines this tool could
 *      run checks on.
 *   2. The same refusal, read the same way, made github.com a WINDOWS DESKTOP.
 *   3. `command -v powershell.exe` answered nothing on `imza-pc-linux`, which has a real
 *      Windows 11 desktop right behind it — that path is put on PATH by an interactive
 *      login shell, and ssh does not run one. So the one true Windows runner in the config
 *      was reported as not Windows, while three git hosts were reported as Windows.
 *
 * There is no network here and no ssh key. `readHostProbe` is the decision on its own, fed
 * the exact bytes the real machines sent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readHostProbe } from '../../src/v2/doctor.js';
import { POWERSHELL_PATHS } from '../../src/v2/remote.js';

/** What github.com writes when it refuses to run a command. Verbatim, on stderr. */
const GITHUB_REFUSAL = {
  stdout: '',
  stderr:
    'Invalid command: echo staysfixed-reachable\n' +
    '  You appear to be using ssh to clone a git:// URL.\n' +
    '  Make sure your core.gitProxy config option and the\n' +
    '  GIT_PROXY_COMMAND environment variable are NOT set.\n',
  why: '',
};

/** OpenSSH's post-quantum warning, which every call to one of these machines carries. */
const BANNER =
  '** WARNING: connection is not using a post-quantum key exchange algorithm.\n' +
  '** This session may be vulnerable to "store now, decrypt later" attacks.\n';

const WSL_POWERSHELL = POWERSHELL_PATHS[0];

describe('what is really on the other end of an ssh host name', () => {
  test('a git host is not a machine you can run anything on, however politely it answers', () => {
    const host = readHostProbe('github-imza', GITHUB_REFUSAL, null);
    assert.equal(host.reachable, false, 'github.com refused the command. That is not a machine this tool can use.');
    assert.match(host.how, /does not give you a shell/);
    assert.notEqual(host.windows, true, 'and it is certainly not a Windows desktop');
  });

  test('a refusal that quotes your own command back cannot answer for the machine', () => {
    // The exact failure: the word IS in the refusal, because the refusal repeats it.
    assert.ok(GITHUB_REFUSAL.stderr.includes('staysfixed-reachable'), 'the trap this test exists for');
    assert.equal(readHostProbe('github-imza', GITHUB_REFUSAL, { stdout: GITHUB_REFUSAL.stderr }).reachable, false);
  });

  test('a real shell answers on standard output, and a warning banner on stderr changes nothing', () => {
    const host = readHostProbe('imza-vps', { stdout: 'staysfixed-reachable\n', stderr: BANNER, why: '' }, { stdout: '' });
    assert.equal(host.reachable, true);
    assert.equal(host.windows, false, 'a Linux server with no /mnt/c is not a Windows desktop');
  });

  test('a WSL shell with powershell.exe on its filesystem IS a Windows desktop, whatever $PATH says', () => {
    // This is case 3. The old probe asked `command -v powershell.exe`, got nothing, and
    // said no. The filesystem says yes, and the filesystem is right.
    const host = readHostProbe(
      'imza-pc-linux',
      { stdout: 'staysfixed-reachable\n', stderr: BANNER, why: '' },
      { stdout: `${WSL_POWERSHELL}\n` }
    );
    assert.equal(host.reachable, true);
    assert.equal(host.windows, true, 'there is a real Windows desktop behind this host and it must not be missed');
    assert.equal(host.powershell, WSL_POWERSHELL, 'and the path that answered is kept, because it is the evidence');
  });

  test('a path that is not one of the three we asked about is not evidence of anything', () => {
    const host = readHostProbe(
      'somewhere',
      { stdout: 'staysfixed-reachable\n', stderr: '', why: '' },
      { stdout: 'ls: cannot access: No such file or directory\n/usr/local/bin/powershell.exe\n' }
    );
    assert.equal(host.windows, false, 'only the paths this tool will actually drive count as a yes');
    assert.equal(host.powershell, undefined);
  });

  test('a machine that says nothing at all is reported as silence, not as a refusal', () => {
    const host = readHostProbe('asleep', { stdout: '', stderr: '', why: 'it did not answer within 8s' }, null);
    assert.equal(host.reachable, false);
    assert.match(host.how, /did not answer within 8s/, 'the reason has to survive: a timeout and a refusal are different problems');
  });

  test('the list of places PowerShell lives is shared with the code that has to run it', () => {
    // Two lists agreeing today and one of them quietly edited in six months is the exact
    // bug this whole tool exists to catch, so doctor reads remote.js rather than keeping
    // its own copy. If this ever fails, somebody has started a second list.
    assert.ok(POWERSHELL_PATHS.length >= 2);
    for (const p of POWERSHELL_PATHS) {
      assert.match(p, /^\//, 'absolute paths only — asking $PATH is what got this wrong in the first place');
      assert.equal(
        readHostProbe('x', { stdout: 'staysfixed-reachable\n', stderr: '', why: '' }, { stdout: `${p}\n` }).windows,
        true,
        `${p} is in the list remote.js will drive, so doctor has to recognise it`
      );
    }
  });
});
