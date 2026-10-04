import { expect, type Locator, type Page } from '@playwright/test';

export const USER = {
  name: 'E2E Tester',
  email: 'e2e@example.com',
  password: 'a-long-test-password',
};

/** First project to run creates the admin account; later ones sign in. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  const setup = page.getByRole('heading', { name: 'Set up Tidepool' });
  const login = page.getByRole('heading', { name: 'Welcome back' });
  await expect(setup.or(login)).toBeVisible();
  if (await setup.isVisible()) {
    await page.getByLabel('Your name').fill(USER.name);
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel(/Password/).fill(USER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
  } else {
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password').fill(USER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByText('Recently added to your library')).toBeVisible();
}

export const playerState = (page: Page) =>
  page.evaluate(() => {
    const s = window.__tidepool!.player();
    return {
      playing: s.playing,
      currentTrackId: s.queue.current?.trackId ?? null,
      upNext: s.queue.upNext.length,
      later: s.queue.later.length,
      history: s.queue.history.length,
      shuffle: s.queue.shuffle,
      repeat: s.queue.repeat,
      engine: s.engineKind,
      position: window.__tidepool!.positionMs(),
    };
  });

export const mediaSessionTitle = (page: Page) =>
  page.evaluate(() => navigator.mediaSession.metadata?.title ?? null);

export async function openAlbum(page: Page, title: string): Promise<void> {
  await page
    .getByRole('link', { name: new RegExp(title) })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

/** Wait until audio is actually advancing (not just "playing" in state). */
export async function expectAudioAdvancing(page: Page): Promise<void> {
  const start = (await playerState(page)).position;
  await expect
    .poll(async () => (await playerState(page)).position, { timeout: 10_000 })
    .toBeGreaterThan(start + 300);
}

/** Tests share one account (and so one saved queue): start each from an empty "Up next". */
export async function clearUpNext(page: Page): Promise<void> {
  await page.goto('/queue');
  await expect(page.getByRole('heading', { name: 'Queue', level: 1 })).toBeVisible();
  const clear = page.getByRole('button', { name: 'Clear queue' });
  if (await clear.isVisible()) await clear.click();
  await page.goto('/');
}

/** Press-and-hold then drag with a finger (Chromium touch events), as on a phone. */
export async function touchDrag(page: Page, handle: Locator, target: Locator): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  const x = from.x + from.width / 2;
  const y0 = from.y + from.height / 2;
  const y1 = to.y + to.height / 4;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  await page.waitForTimeout(250); // longer than the sensor's hold delay
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 10 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
