/**
 * Store screenshots, shot from the real bundles.
 *
 * The panel and the popup are loaded in an iframe with `chrome.*` answered
 * from a fixture instead of a service worker, inside a frame page that carries
 * the caption. 800x500 at a scale of 1.6 is 1280x800, which is what the store
 * takes.
 *
 *   node shoot/shots.cjs
 */
const path = require('path');
const { chromium } = require(path.join(process.env.HOME, 'Projects/rnd/playwright/node_modules/playwright'));
const install = require('./stub.js');

const HERE = __dirname;
const OUT = path.join(HERE, 'out');
const frameUrl = (shot) => `file://${path.join(HERE, 'frame.html')}#${encodeURIComponent(JSON.stringify(shot))}`;

const HANDBOOK = '/Users/sarah/Projects/docs';
const PRODUCT = '/Users/sarah/Projects/product-docs';

const now = Date.now();
const hours = (n) => now - n * 3600_000;
const at = (base, minutes) => base + minutes * 60_000;

const MEETINGS = [
  {
    id: 'm1', meetingCode: 'abc-defg-hij', title: 'Q2 Product Planning', description: '',
    startTime: hours(0.4), endTime: null,
    participants: { d1: 'Sarah Chen', d2: 'Marcus Reid', d3: 'Priya Sharma' },
    entries: [
      { id: 'e1', speaker: 'Sarah Chen', timestamp: at(hours(0.4), 3), text: "Alright, let's get started. Today we're planning the Q2 roadmap, and the main focus is the new onboarding flow." },
      { id: 'e2', speaker: 'Marcus Reid', timestamp: at(hours(0.4), 4), text: "I've pushed the initial designs. The main change is that account setup moves to after the first real result, instead of right at signup." },
      { id: 'e3', speaker: 'Priya Sharma', timestamp: at(hours(0.4), 6), text: 'That matches the research. People dropped off when they had to fill in company details before seeing any value.' },
      { id: 'e4', speaker: 'Sarah Chen', timestamp: at(hours(0.4), 8), text: 'Agreed. Marcus, how long until we have a testable prototype?' },
      { id: 'e5', speaker: 'Marcus Reid', timestamp: at(hours(0.4), 9), text: 'End of next week for a clickable one. Engineering needs two more weeks on top of that for a working build.' },
      { id: 'e6', speaker: 'Priya Sharma', timestamp: at(hours(0.4), 11), text: 'We should rebuild the backend queries at minimum. The UI can stay for now.' },
    ],
  },
  {
    id: 'm2', meetingCode: 'klm-nopq-rst', title: 'Design Review, Onboarding Flow', description: '',
    startTime: hours(4), endTime: hours(4) + 47 * 60_000,
    participants: { d4: 'Lena Volkov', d5: 'James Okafor' },
    entries: [
      { id: 'f1', speaker: 'Lena Volkov', timestamp: at(hours(4), 2), text: "I've updated the file with the new onboarding screens. The setup is three steps now instead of one long form." },
      { id: 'f2', speaker: 'James Okafor', timestamp: at(hours(4), 4), text: 'Much cleaner. Did you keep the progress indicator at the top? People said they liked it in the last round.' },
      { id: 'f3', speaker: 'Lena Volkov', timestamp: at(hours(4), 5), text: "It's still there. I also added small transitions between the steps." },
      { id: 'f4', speaker: 'James Okafor', timestamp: at(hours(4), 8), text: 'The colours on step two are a bit off. The grey background with the blue button is not enough contrast on a phone.' },
      { id: 'f5', speaker: 'Lena Volkov', timestamp: at(hours(4), 10), text: "Good catch. I'll take the button up to 4.5 to 1." },
    ],
  },
  {
    id: 'm3', meetingCode: 'uvw-xyza-bcd', title: 'Engineering Sync', description: '',
    startTime: hours(27), endTime: hours(27) + 31 * 60_000,
    participants: { d2: 'Marcus Reid', d6: 'Tomasz Wisniewski', d1: 'Sarah Chen' },
    entries: [
      { id: 'g1', speaker: 'Tomasz Wisniewski', timestamp: at(hours(27), 1), text: 'Quick heads up, the pipeline is failing on the new migration. It looks like a column name conflict.' },
      { id: 'g2', speaker: 'Marcus Reid', timestamp: at(hours(27), 3), text: "I saw that. The migration runs before the index is dropped. I'll fix the ordering." },
    ],
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
    popup_size: { width: 400, height: 336 },
    popup_position: { right: '14px', top: '14px' },
  },
  ...over,
});

async function shoot(browser, name, shot, fix, after) {
  const context = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1.6 });
  await context.addInitScript(install, fix);
  const page = await context.newPage();
  await page.goto(frameUrl(shot));
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  await frame.evaluate((snapshot) => window.__deliver({ type: 'notula_snapshot', snapshot }), SNAPSHOT);
  if (after) await after(frame, page);
  if (shot.fit) {
    const height = await frame.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await page.evaluate((h) => { document.querySelector('iframe').style.height = h + 'px'; }, Math.min(height, 444));
    console.log(`  ${name}: content ${height}px`);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await context.close();
  console.log(name);
}

(async () => {
  const browser = await chromium.launch();

  await shoot(browser, '1-live', {
    layout: 'wide',
    title: 'Every word, while it is still being said',
    src: './call.html', w: 712, h: 366, plain: true,
  }, fixture(), async (frame, page) => {
    await frame.evaluate(() => window.__runtime({ type: 'toggle_popup' }));
    await frame.evaluate((m) => window.__deliver({
      type: 'meeting_snapshot',
      meeting: m,
      entries: m.entries,
      notes: [],
    }), MEETINGS[0]);
    // The panel is in a closed shadow root, so the only way in is a real press.
    const box = await (await page.waitForSelector('iframe')).boundingBox();
    await page.mouse.click(box.x + box.width - 14 - 400 + 384, box.y + 14 + 118);
  });

  await shoot(browser, '2-saved', {
    layout: 'side',
    title: 'Every call ends up in your repository',
    sub: 'A finished meeting writes itself into a Markdown file, in the folder you picked for it. Nothing to copy by hand.',
    src: '../popup.html', w: 340, h: 424, fit: true,
  }, fixture());

  await shoot(browser, '3-picker', {
    layout: 'side',
    title: 'You say where it is saved',
    sub: 'One folder for everything, or a different one per call. A meeting that comes back every week goes where it went last time.',
    src: '../popup.html', w: 340, h: 424, fit: true,
  }, fixture(), async (frame) => {
    await frame.click('#default-line .dest');
  });

  await shoot(browser, '4-transcript', {
    layout: 'side',
    title: 'The transcript, with who said it',
    sub: 'Speaker names come from the call itself. Copy it as Markdown, or download the file.',
    src: '../popup.html', w: 340, h: 424, fit: true,
  }, fixture(), async (frame) => {
    await frame.click('.meeting-item:nth-child(2) .meeting-item-title');
  });

  // The Notula side of it, from the app's own harness (pnpm --filter @notula/desktop harness).
  await shoot(browser, '5-pairing', {
    layout: 'wide',
    title: 'Notula asks first',
    sub: 'The extension writes into a folder only after you have let it in, and only into the repositories Notula has open.',
    src: 'http://localhost:5599/', w: 400, h: 300, plain: true,
  }, fixture(), async (frame, page) => {
    await frame.click('.harness-bar button:text-is("Pairing")');
    await frame.addStyleTag({ content: '.harness-bar, .harness-row { display: none !important; } .overlay { background: transparent !important; } html, body { background: transparent !important; }' });
    const box = await (await frame.waitForSelector('.dialog.pair')).boundingBox();
    await page.evaluate((size) => {
      const frameEl = document.querySelector('iframe');
      frameEl.style.width = size.w + 'px';
      frameEl.style.height = size.h + 'px';
    }, { w: Math.ceil(box.width) + 60, h: Math.ceil(box.height) + 60 });
  });

  await browser.close();
})();
