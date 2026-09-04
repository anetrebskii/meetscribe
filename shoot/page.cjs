/**
 * The captures notula.org/meet is built around. Same rig as the store
 * screenshots, but unframed: the page supplies its own caption and its own
 * shadow, so a caption baked into the picture would be said twice.
 *
 * Shot at a device scale of 2, the way the landing's own shots are, then
 * written as webp at q86 next to the PNG.
 *
 *   node shoot/page.cjs
 */
const path = require('path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(path.join(process.env.HOME, 'Projects/rnd/playwright/node_modules/playwright'));
const install = require('./stub.js');

const HERE = __dirname;
const OUT = path.join(HERE, 'out');

const HANDBOOK = '/Users/sarah/Projects/docs';
const PRODUCT = '/Users/sarah/Projects/product-docs';
const now = Date.now();
const hours = (n) => now - n * 3600_000;
const at = (base, minutes) => base + minutes * 60_000;

const LIVE = {
  id: 'm1', meetingCode: 'abc-defg-hij', title: 'Q2 Product Planning', description: '',
  startTime: hours(0.4), endTime: null,
  participants: { d1: 'Sarah Chen', d2: 'Marcus Reid', d3: 'Priya Sharma' },
  entries: [
    { id: 'e1', speaker: 'Sarah Chen', timestamp: at(hours(0.4), 3), text: "Alright, let's get started. Today we're planning the Q2 roadmap, and the main focus is the new onboarding flow." },
    { id: 'e2', speaker: 'Marcus Reid', timestamp: at(hours(0.4), 4), text: "I've pushed the initial designs. The main change is that account setup moves to after the first real result, instead of right at signup." },
    { id: 'e3', speaker: 'Priya Sharma', timestamp: at(hours(0.4), 6), text: 'That matches the research. People dropped off when they had to fill in company details before seeing any value.' },
    { id: 'e4', speaker: 'Sarah Chen', timestamp: at(hours(0.4), 8), text: 'Agreed. Marcus, how long until we have a testable prototype?' },
    { id: 'e5', speaker: 'Marcus Reid', timestamp: at(hours(0.4), 9), text: 'End of next week for a clickable one. Engineering needs two more weeks on top of that for a working build.' },
  ],
};

const MEETINGS = [
  LIVE,
  {
    id: 'm2', meetingCode: 'klm-nopq-rst', title: 'Design Review, Onboarding Flow', description: '',
    startTime: hours(4), endTime: hours(4) + 47 * 60_000,
    participants: { d4: 'Lena Volkov', d5: 'James Okafor' },
    entries: [{ id: 'f1', speaker: 'Lena Volkov', timestamp: hours(4), text: 'Three steps now, not one long form.' }],
  },
  {
    id: 'm3', meetingCode: 'uvw-xyza-bcd', title: 'Engineering Sync', description: '',
    startTime: hours(27), endTime: hours(27) + 31 * 60_000,
    participants: { d2: 'Marcus Reid', d6: 'Tomasz Wisniewski', d1: 'Sarah Chen' },
    entries: [{ id: 'g1', speaker: 'Marcus Reid', timestamp: hours(27), text: 'The migration ordering is fixed.' }],
  },
];

const SNAPSHOT = {
  status: { state: 'paired' },
  workspaces: [{ root: HANDBOOK, name: 'docs' }, { root: PRODUCT, name: 'product-docs' }],
  folders: {
    [HANDBOOK]: ['meetings', 'decisions', 'notes', 'onboarding'],
    [PRODUCT]: ['meetings', 'research', 'specs'],
  },
  memory: { default: { workspace: HANDBOOK, folder: 'meetings' }, byCode: {} },
  saves: {
    m2: { state: 'saved', workspace: HANDBOOK, folder: 'meetings', path: 'meetings/design-review-onboarding-flow.md', savedAt: hours(4) },
  },
  notices: { renamed: 'seen', backfill: 'seen' },
  backfill: 0,
};

const fixture = (over = {}) => ({
  meetings: MEETINGS,
  live: ['m1'],
  language: 'en-US',
  storage: {
    settings: { enabled: true, language: 'en-US' },
    recentLanguages: ['en-US'],
    popup_size: { width: 400, height: 520 },
    popup_position: { right: '24px', top: '24px' },
  },
  ...over,
});

async function write(page, name, clip) {
  const png = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: png, clip });
  execFileSync('cwebp', ['-q', '86', '-quiet', png, '-o', path.join(OUT, `${name}.webp`)]);
  console.log(name);
}

(async () => {
  const browser = await chromium.launch();

  // The panel where it actually is: over the call, with the transcript running.
  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 664 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(install, fixture());
    const page = await ctx.newPage();
    await page.goto(`file://${path.join(HERE, 'call.html')}`);
    await page.evaluate(() => window.__runtime({ type: 'toggle_popup' }));
    await page.waitForTimeout(300);
    await page.evaluate((s) => window.__deliver({ type: 'notula_snapshot', snapshot: s }), SNAPSHOT);
    await page.evaluate((m) => window.__deliver({ type: 'meeting_snapshot', meeting: m, entries: m.entries, notes: [] }), LIVE);
    await page.waitForTimeout(400);
    // Closed shadow root: the Notes fold only collapses under a real press.
    await page.mouse.click(1180 - 24 - 400 + 382, 24 + 118);
    await page.waitForTimeout(400);
    await write(page, 'meet-panel');
    await ctx.close();
  }

  // The popup on its own, for the column beside the prose.
  for (const [name, after] of [
    ['meet-popup', null],
    ['meet-picker', async (page) => { await page.click('#default-line .dest'); await page.waitForTimeout(300); }],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 520 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(install, fixture({ live: [] }));
    const page = await ctx.newPage();
    await page.goto('file:///Users/alex/Projects/mine/meetscribe/popup.html');
    await page.evaluate((s) => window.__deliver({ type: 'notula_snapshot', snapshot: s }), SNAPSHOT);
    await page.waitForTimeout(400);
    if (after) await after(page);
    const h = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await write(page, name, { x: 0, y: 0, width: 340, height: Math.min(h, 520) });
    await ctx.close();
  }

  await browser.close();
})();
