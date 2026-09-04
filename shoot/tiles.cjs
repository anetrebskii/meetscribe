/**
 * The two store promo tiles, shot the same way as the screenshots: the marquee
 * shows the real popup from the real bundle, the small one shows the rings.
 *
 *   node shoot/tiles.cjs
 */
const path = require('path');
const { chromium } = require(path.join(process.env.HOME, 'Projects/rnd/playwright/node_modules/playwright'));
const install = require('./stub.js');

const HERE = __dirname;
const OUT = path.join(HERE, 'out');
const url = (shot) => `file://${path.join(HERE, 'tile.html')}#${encodeURIComponent(JSON.stringify(shot))}`;

const HANDBOOK = '/Users/sarah/Projects/docs';
const now = Date.now();
const hours = (n) => now - n * 3600_000;

const MEETINGS = [
  {
    id: 'm1', meetingCode: 'abc-defg-hij', title: 'Q2 Product Planning', description: '',
    startTime: hours(0.4), endTime: null,
    participants: { d1: 'Sarah Chen', d2: 'Marcus Reid', d3: 'Priya Sharma' },
    entries: [{ id: 'e1', speaker: 'Sarah Chen', timestamp: hours(0.4), text: "Let's plan the Q2 roadmap." }],
  },
  {
    id: 'm2', meetingCode: 'klm-nopq-rst', title: 'Design Review, Onboarding Flow', description: '',
    startTime: hours(4), endTime: hours(4) + 47 * 60_000,
    participants: { d4: 'Lena Volkov', d5: 'James Okafor' },
    entries: [{ id: 'f1', speaker: 'Lena Volkov', timestamp: hours(4), text: 'Three steps now, not one long form.' }],
  },
  {
    id: 'm3', meetingCode: 'uvw-xyza-bcd', title: 'Engineering Sync', description: '',
    startTime: hours(27), endTime: hours(27) + 31 * 60_000,
    participants: { d2: 'Marcus Reid', d6: 'Tomasz Wisniewski' },
    entries: [{ id: 'g1', speaker: 'Marcus Reid', timestamp: hours(27), text: 'The migration ordering is fixed.' }],
  },
];

const SNAPSHOT = {
  status: { state: 'paired' },
  workspaces: [{ root: HANDBOOK, name: 'docs' }],
  folders: { [HANDBOOK]: ['meetings', 'decisions', 'notes'] },
  memory: { default: { workspace: HANDBOOK, folder: 'meetings' }, byCode: {} },
  saves: { m2: { state: 'saved', workspace: HANDBOOK, folder: 'meetings', path: 'meetings/design-review.md', savedAt: hours(4) } },
  notices: { renamed: 'seen', backfill: 'seen' },
  backfill: 0,
};

const fixture = {
  meetings: MEETINGS,
  live: ['m1'],
  language: 'en-US',
  storage: { settings: { enabled: true, language: 'en-US' }, recentLanguages: ['en-US'] },
};

async function shoot(browser, name, shot, size) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  await context.addInitScript(install, fixture);
  const page = await context.newPage();
  await page.goto(url(shot));
  if (shot.src) {
    const frame = await (await page.waitForSelector('iframe')).contentFrame();
    await frame.waitForLoadState('domcontentloaded');
    await frame.evaluate((snapshot) => window.__deliver({ type: 'notula_snapshot', snapshot }), SNAPSHOT);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await context.close();
  console.log(name, size.width + 'x' + size.height);
}

(async () => {
  const browser = await chromium.launch();

  await shoot(browser, 'tile-small', {
    kind: 'small',
    title: 'Build <em>AI brain</em> with Notula',
    sub: 'Every Google Meet call, transcribed with speaker names and saved as Markdown into your repository.',
  }, { width: 440, height: 280 });

  await shoot(browser, 'tile-marquee', {
    kind: 'marquee',
    title: 'Build <em>AI brain</em> with Notula',
    sub: 'Every Google Meet call, transcribed with speaker names and saved as Markdown into the repository your assistants already read.',
    src: '../popup.html', w: 400, h: 448,
  }, { width: 1400, height: 560 });

  await browser.close();
})();
