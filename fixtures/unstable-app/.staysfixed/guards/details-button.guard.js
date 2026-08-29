/**
 * A guard that passes.
 *
 * It is deliberately about behaviour a picture cannot see: the button is on
 * screen in both cases, so only clicking it proves the route still works.
 */

export default {
  name: 'the details button still opens the details page',

  fixed: '2026-08-29',

  because:
    'The button was wired to a router that had already been torn down, so clicking it changed the address bar and nothing else. It looked fine in every screenshot.',

  async run({ open, click, expect, page }) {
    await open('/');

    await expect('the details page is not showing yet', async () => {
      return (await page.visible('[data-sf="details-heading"]')) === false;
    });

    await click('[data-sf="go-details"]');
    await page.waitFor('[data-sf="details-heading"]');

    await expect('the address ends up on the details route', async () => {
      return (await page.url()).endsWith('#/details');
    });

    await expect('the details heading is on screen', async () => {
      return await page.visible('[data-sf="details-heading"]');
    });

    await expect('the home view is put away', async () => {
      return (await page.visible('[data-sf="bars"]')) === false;
    });
  },
};
