import { expect, test } from '@playwright/test';
import {
  clearUpNext,
  expectAudioAdvancing,
  mediaSessionTitle,
  openAlbum,
  playerState,
  signIn,
  touchDrag,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('signs in and lists the library', async ({ page }) => {
  await signIn(page);
  for (const title of ['Tagged Album', 'Folder Album', 'Compilation Hits']) {
    await expect(page.getByRole('link', { name: new RegExp(title) }).first()).toBeVisible();
  }
});

test('plays an album, updates lock-screen metadata and advances on its own', async ({
  page,
}, info) => {
  await signIn(page);
  await clearUpNext(page);
  await openAlbum(page, 'Tagged Album');
  await page.getByRole('button', { name: 'Play Tagged Album' }).click();

  await expect.poll(() => mediaSessionTitle(page)).toBe('First Song');
  await expectAudioAdvancing(page);
  const s = await playerState(page);
  expect(s.engine).toBe(info.project.name === 'iphone' ? 'element' : 'dual');
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');

  // First Song is 4 s long: the next one starts by itself (gapless on desktop, `ended` on iPhone).
  await expect.poll(() => mediaSessionTitle(page), { timeout: 15_000 }).toBe('Second Song');
  await expectAudioAdvancing(page);
  expect((await playerState(page)).history).toBeGreaterThanOrEqual(1);
});

test('transport controls: pause, previous, next, shuffle, repeat', async ({ page }, info) => {
  await signIn(page);
  await clearUpNext(page);
  await openAlbum(page, 'Folder Album');
  await page.getByRole('button', { name: 'Play Folder Album' }).click();
  await expect.poll(() => mediaSessionTitle(page)).toBe('Untagged Song');

  if (info.project.name === 'iphone')
    await page.getByRole('button', { name: 'Open now playing' }).click();
  const bar =
    info.project.name === 'iphone'
      ? page.getByRole('dialog', { name: 'Now playing' })
      : page.getByRole('region', { name: 'Player' });

  await bar.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => mediaSessionTitle(page)).toBe('Another Untagged');
  await bar.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect.poll(() => mediaSessionTitle(page)).toBe('Untagged Song');

  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await playerState(page)).playing).toBe(false);
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await playerState(page)).playing).toBe(true);

  await bar.getByRole('button', { name: 'Shuffle: off' }).click();
  await expect(bar.getByRole('button', { name: 'Shuffle: on' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await bar.getByRole('button', { name: 'Repeat: off' }).click();
  await expect(bar.getByRole('button', { name: 'Repeat: all' })).toBeVisible();
  await bar.getByRole('button', { name: 'Repeat: all' }).click();
  await expect(bar.getByRole('button', { name: 'Repeat: one track' })).toBeVisible();
  await bar.getByRole('button', { name: 'Repeat: one track' }).click();
  await bar.getByRole('button', { name: 'Shuffle: on' }).click();
  expect(await playerState(page)).toMatchObject({ shuffle: false, repeat: 'off' });
});

test('queue: add, play next, reorder, remove, and it survives a reload', async ({ page }, info) => {
  await signIn(page);
  await clearUpNext(page);
  await openAlbum(page, 'Tagged Album');
  await page.getByRole('button', { name: 'Play Tagged Album' }).click();
  await expect.poll(() => mediaSessionTitle(page)).toBe('First Song');

  await page.goto('/');
  await openAlbum(page, 'Folder Album');
  await page.getByRole('button', { name: 'More options for Another Untagged' }).click();
  await page.getByRole('menuitem', { name: 'Add to queue' }).click();
  await page.getByRole('button', { name: 'More options for Untagged Song' }).click();
  await page.getByRole('menuitem', { name: 'Play next' }).click();

  await page.goto('/queue');
  const next = page
    .getByRole('region', { name: 'Next in queue' })
    .or(page.locator('section[aria-labelledby="q-next"]'));
  await expect(next.getByText('Untagged Song')).toBeVisible();
  const rows = next.locator('li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Untagged Song');

  const handle = next.getByRole('button', { name: 'Reorder Another Untagged' });
  if (info.project.name === 'iphone') {
    // Finger: hold the grip, drag it above the first row.
    await touchDrag(page, handle, rows.nth(0));
  } else {
    // Keyboard drag-and-drop: pick up, move up, drop.
    await handle.focus();
    for (const key of ['Space', 'ArrowUp', 'Space']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150); // dnd-kit measures/animates between steps
    }
  }
  await expect(rows.nth(0)).toContainText('Another Untagged');

  await next.getByRole('button', { name: 'Remove Untagged Song from queue' }).click();
  await expect(rows).toHaveCount(1);

  // Reload: the queue and current track come back (paused, not auto-playing).
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Queue', exact: true, level: 1 })).toBeVisible();
  await expect.poll(async () => (await playerState(page)).upNext).toBe(1);
  expect((await playerState(page)).playing).toBe(false);
  await expect.poll(() => mediaSessionTitle(page)).not.toBeNull();
});

test('keyboard shortcuts (desktop)', async ({ page }, info) => {
  test.skip(info.project.name === 'iphone', 'no keyboard on a phone');
  await signIn(page);
  await openAlbum(page, 'Tagged Album');
  await page.getByRole('button', { name: 'Play Tagged Album' }).click();
  await expectAudioAdvancing(page);
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('Space');
  await expect.poll(async () => (await playerState(page)).playing).toBe(false);
  await page.keyboard.press('s');
  await expect.poll(async () => (await playerState(page)).shuffle).toBe(true);
  await page.keyboard.press('s');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape').catch(() => undefined);
});

test('settings persist', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await page.getByLabel('Quality on Wi-Fi').selectOption('NORMAL');
  await page.getByRole('switch', { name: 'Equaliser' }).click();
  await page.getByRole('button', { name: 'Bass boost' }).click();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByLabel('Quality on Wi-Fi')).toHaveValue('NORMAL');
  await expect(page.getByRole('button', { name: 'Bass boost' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Put things back for the next project.
  await page.getByLabel('Quality on Wi-Fi').selectOption('HIGH');
  await page.getByRole('switch', { name: 'Equaliser' }).click();
  await page.waitForTimeout(300);
});
