(function () {
  const LOG_PREFIX = '[MeetTranscript:Captions]';
  const MSG_CAPTION_SPEAKER_NAME = 'caption_speaker_name';
  let captionAutoEnabled = false;

  function log(...args: unknown[]): void {
    console.log(LOG_PREFIX, ...args);
  }

  // ========================================
  // Hide native caption overlay (off-screen, NOT display:none so DOM stays live)
  // ========================================

  function hideCaptionOverlay(): void {
    if (document.getElementById('__meet-transcription-hide-cc')) return;
    const style = document.createElement('style');
    style.id = '__meet-transcription-hide-cc';
    style.textContent = `
      .a4cQT,
      [jscontroller="D1tHje"],
      [jscontroller="TEjod"],
      div[jsname="r4nke"] {
        opacity: 0 !important;
        pointer-events: none !important;
        position: fixed !important;
        left: -99999px !important;
        top: -99999px !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ========================================
  // Scan participant names from Google Meet UI (video tiles / people panel)
  // ========================================

  const knownParticipants = new Set<string>();

  // Filter out duration strings, timestamps, and other non-name text from DOM
  const NON_NAME_RE = /^\d+\s*(min|sec|hr|hour|:\d)/i;

  function isValidName(name: string | null | undefined): name is string {
    if (!name) return false;
    const trimmed = name.trim();
    return trimmed.length >= 2 && trimmed.length <= 60 && !NON_NAME_RE.test(trimmed);
  }

  function scanParticipantNames(): void {
    const names: string[] = [];

    // Strategy 1: data-self-name attribute (local user's name)
    const selfEl = document.querySelector('[data-self-name]');
    if (selfEl) {
      const name = selfEl.getAttribute('data-self-name')?.trim();
      if (name) names.push(name);
    }

    // Strategy 2: Participant name overlays on video tiles
    // Google Meet uses .zWGUib, .XEazBc, or .cS7aqe for name labels on tiles
    const nameOverlays = document.querySelectorAll(
      '.zWGUib, .XEazBc, .cS7aqe, [data-participant-id] .ZjFb7c, [data-requested-participant-id] .ZjFb7c'
    );
    for (const el of nameOverlays) {
      const name = el.textContent?.trim();
      if (isValidName(name)) {
        names.push(name);
      }
    }

    // Strategy 3: People panel (if open)
    const peopleItems = document.querySelectorAll(
      '[data-participant-id] [data-hovercard-id], .rua5Nb, .cS7aqe'
    );
    for (const el of peopleItems) {
      const name = el.textContent?.trim();
      if (isValidName(name)) {
        names.push(name);
      }
    }

    // Deduplicate and emit new names
    for (const name of names) {
      if (!knownParticipants.has(name)) {
        knownParticipants.add(name);
        log('Found participant name:', name);
        chrome.runtime.sendMessage({
          type: MSG_CAPTION_SPEAKER_NAME,
          speakerName: name,
        }).catch(() => {});
      }
    }
  }

  function startParticipantScanner(): void {
    // Scan every 3 seconds — participants don't change often
    setInterval(scanParticipantNames, 3000);
    // Initial scan after a short delay
    setTimeout(scanParticipantNames, 1000);
    log('Participant name scanner started');
  }

  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function clickAndWait(el: Element, waitMs = 300): Promise<void> {
    (el as HTMLElement).click();
    await delay(waitMs);
  }

  function findButtonByLabel(labelSubstring: string): HTMLElement | null {
    const buttons = document.querySelectorAll('button[aria-label]');
    for (const btn of buttons) {
      const label = btn.getAttribute('aria-label') ?? '';
      if (label.toLowerCase().includes(labelSubstring.toLowerCase())) {
        return btn as HTMLElement;
      }
    }
    return null;
  }

  function findIconButton(iconText: string, container: Element = document.body): HTMLElement | null {
    const icons = container.querySelectorAll('i.google-material-icons, span.google-material-icons');
    for (const icon of icons) {
      if (icon.textContent?.trim() === iconText) {
        const btn = icon.closest('button, [role="button"], [role="menuitem"], [jsaction]');
        return (btn as HTMLElement) ?? null;
      }
    }
    return null;
  }

  async function tryDirectCaptionButton(): Promise<boolean> {
    const labels = ['turn on captions', 'captions', 'closed caption', 'subtitles'];
    for (const label of labels) {
      const btn = findButtonByLabel(label);
      if (btn) {
        const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase();
        if (ariaLabel.includes('turn off') || ariaLabel.includes('hide')) {
          log('Captions already enabled');
          return true;
        }
        log('Found caption button, clicking:', ariaLabel);
        await clickAndWait(btn, 500);
        return true;
      }
    }
    return false;
  }

  async function tryMenuCaptionEnable(): Promise<boolean> {
    const moreBtn = findButtonByLabel('more options') ?? findIconButton('more_vert');
    if (!moreBtn) {
      log('Could not find "More options" button');
      return false;
    }

    await clickAndWait(moreBtn, 400);

    const menu = document.querySelector('[role="menu"]');
    if (menu) {
      const menuItems = menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');
      for (const item of menuItems) {
        const text = item.textContent?.toLowerCase() ?? '';
        if (text.includes('caption') && (text.includes('turn on') || text.includes('enable'))) {
          log('Found "Turn on captions" in menu');
          await clickAndWait(item, 500);
          return true;
        }
      }

      const settingsItem = findIconButton('settings', menu);
      if (settingsItem) {
        await clickAndWait(settingsItem, 500);

        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          const tabIcon = tab.querySelector('i.google-material-icons, span.google-material-icons');
          if (tabIcon?.textContent?.trim() === 'closed_caption') {
            await clickAndWait(tab, 400);
            break;
          }
        }

        const panel = document.querySelector('[role="tabpanel"]');
        if (panel) {
          const toggle = panel.querySelector('[role="switch"], [role="checkbox"], input[type="checkbox"]') as HTMLElement | null;
          if (toggle) {
            const isOn = toggle.getAttribute('aria-checked') === 'true' || (toggle as HTMLInputElement).checked;
            if (!isOn) {
              log('Enabling captions via settings toggle');
              await clickAndWait(toggle, 400);
            }
          }
        }

        const closeBtn = document.querySelector('[aria-label="Close"]') as HTMLElement | null;
        if (closeBtn) {
          closeBtn.click();
        } else {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }

        await delay(200);
        return true;
      }
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  async function autoEnableCaptions(retries = 3): Promise<void> {
    if (captionAutoEnabled) return;

    for (let attempt = 0; attempt < retries; attempt++) {
      log(`Auto-enable captions attempt ${attempt + 1}/${retries}`);

      const existing = document.querySelector('.a4cQT');
      if (existing && existing.textContent && existing.textContent.trim().length > 0) {
        log('Captions already active');
        captionAutoEnabled = true;
        hideCaptionOverlay();
        startParticipantScanner();
        return;
      }

      if (await tryDirectCaptionButton()) {
        captionAutoEnabled = true;
        hideCaptionOverlay();
        startParticipantScanner();
        return;
      }

      if (await tryMenuCaptionEnable()) {
        captionAutoEnabled = true;
        hideCaptionOverlay();
        startParticipantScanner();
        return;
      }

      await delay(5000);
    }

    log('Could not auto-enable captions after', retries, 'attempts');
  }

  function isMeetingJoined(): boolean {
    return !!(
      document.querySelector('[data-call-ended]') === null &&
      (findButtonByLabel('microphone') || findButtonByLabel('camera') || findIconButton('mic'))
    );
  }

  // Inject hiding CSS early
  if (document.head) {
    hideCaptionOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', hideCaptionOverlay);
  }

  // Auto-enable captions once meeting is joined
  let autoEnableCheckInterval: ReturnType<typeof setInterval> | null = null;

  function checkAndAutoEnable(): void {
    if (captionAutoEnabled) {
      if (autoEnableCheckInterval) {
        clearInterval(autoEnableCheckInterval);
        autoEnableCheckInterval = null;
      }
      return;
    }
    if (isMeetingJoined()) {
      log('Meeting joined detected, will auto-enable captions');
      if (autoEnableCheckInterval) {
        clearInterval(autoEnableCheckInterval);
        autoEnableCheckInterval = null;
      }
      setTimeout(() => autoEnableCaptions(), 3000);
    }
  }

  autoEnableCheckInterval = setInterval(checkAndAutoEnable, 2000);
})();
