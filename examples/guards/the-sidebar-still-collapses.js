/**
 * A guard, written the way guards are meant to be written.
 *
 * A guard is one check per bug that has already been fixed once. Its only job is
 * to fail on the day that bug comes back. It is not a unit test and it is not a
 * spec — nobody adds a guard for behaviour that has never broken.
 *
 * Drop files like this one into `.staysfixed/guards/`. They are plain JavaScript
 * modules; the default export is the guard. A file may also export an array of
 * guards, or several named ones.
 */

/** @type {import('../../src/types.js').Guard} */
const guard = {
  // The name is the whole handover. It is what prints when the guard fails, what
  // goes in the report, and what an agent reads before deciding whether it broke
  // something. Write what the app is supposed to do, in the words you would say
  // out loud. `sidebar_collapse_test` would be refused, and rightly.
  name: 'the sidebar still collapses',

  // When it was fixed. Free text — a date, a version, whatever you would say.
  fixed: '2026-08-14',

  // The story of the bug, in one or two sentences. This is printed underneath
  // the failure, so the person who has never seen this bug knows in five seconds
  // what they are looking at and whether it matters.
  because:
    'A CSS refactor renamed .sidebar--open to .sidebar-open everywhere except the toggle handler, ' +
    'so the collapse button did nothing and the sidebar was stuck open on every screen under 900px wide. ' +
    'It shipped and nobody noticed for four days.',

  // Where to read more. An issue, a commit, a session note — anything.
  link: 'https://github.com/asadev/staysfixed/issues/12',

  // How long this guard gets before it is called failed. Default 30000.
  timeoutMs: 20_000,

  // Set `skip: true` to park a guard without deleting it. `check` reports it as
  // left out on purpose, so nobody mistakes it for passing.
  // skip: true,

  /**
   * Everything the guard needs is on `app`: the full page, shorthands for the
   * two things guards do most, `expect` for assertions, `run` for a shell
   * command, `read` for a project file.
   *
   * @param {import('../../src/types.js').GuardApi} app
   */
  async run(app) {
    const { page, expect } = app;

    await app.open('/');
    await page.waitFor('.sidebar');

    // Assertions are a sentence plus a check, never a bare comparison. When this
    // fails the person reading the terminal sees
    //   expected: the sidebar starts open
    // which anyone can act on, six months from now, at one in the morning.
    await expect('the sidebar starts open', () => page.visible('.sidebar'));

    await app.click('[data-action="toggle-sidebar"]');
    await page.waitForGone('.sidebar--open');

    await expect('clicking the toggle hides the sidebar', async () => !(await page.visible('.sidebar')));

    // The bug was that the class name and the handler disagreed. Check the thing
    // that actually broke, not only the thing you can see — a future refactor
    // could hide the sidebar a different way and this guard should still hold.
    await expect('the collapsed sidebar keeps its collapsed class', async () => {
      const classes = await page.evaluate('document.querySelector(".sidebar").className');
      return String(classes).includes('sidebar--collapsed');
    });

    // And that it comes back, because a collapse you cannot undo is a worse bug
    // than the one we were fixing.
    await app.click('[data-action="toggle-sidebar"]');
    await page.waitFor('.sidebar--open');
    await expect('clicking the toggle again brings the sidebar back', () => page.visible('.sidebar'));

    // Guards do not have to be about the screen at all. This one is, but a guard
    // can equally run a command or read a file:
    //
    //   const { code } = await app.run('npm run build');
    //   await expect('the production build still succeeds', () => code === 0);
    //
    //   const css = await app.read('src/styles/sidebar.css');
    //   await expect('the collapsed class is still defined', () => css.includes('.sidebar--collapsed'));
  },
};

export default guard;
