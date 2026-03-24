(function () {
  const LOG_PREFIX = '[MeetTranscript:Captions]';
  const MSG_CAPTION_SPEAKER_NAME = 'caption_speaker_name';
  const MSG_RETRY_CAPTIONS = 'retry_captions';
  let captionAutoEnabled = false;
  let participantScannerStarted = false;
  let contextInvalidated = false;

  function isContextInvalidated(): boolean {
    if (contextInvalidated) return true;
    try {
      void chrome.runtime.id;
      return false;
    } catch {
      contextInvalidated = true;
      return true;
    }
  }

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
        if (isContextInvalidated()) return;
        chrome.runtime.sendMessage({
          type: MSG_CAPTION_SPEAKER_NAME,
          speakerName: name,
        }).catch(() => {});
      }
    }
  }

  function startParticipantScanner(): void {
    if (participantScannerStarted) return;
    participantScannerStarted = true;
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

  /** Check if captions are visibly active in the DOM. */
  function areCaptionsActive(): boolean {
    // Check for the native caption overlay container with content
    const overlay = document.querySelector('.a4cQT');
    if (overlay && overlay.textContent && overlay.textContent.trim().length > 0) return true;

    // Check for a "turn off captions" button (indicates captions are on)
    const buttons = document.querySelectorAll('button[aria-label]');
    for (const btn of buttons) {
      const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
      if (
        (label.includes('caption') || label.includes('subtitle')) &&
        (label.includes('turn off') || label.includes('hide') || label.includes('disable'))
      ) {
        return true;
      }
    }

    return false;
  }

  async function tryDirectCaptionButton(): Promise<boolean> {
    // First check if captions are already active
    if (areCaptionsActive()) {
      log('Captions already enabled (verified)');
      return true;
    }

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
        await clickAndWait(btn, 1000);

        // Verify captions actually activated after clicking
        if (areCaptionsActive()) {
          log('Captions verified active after click');
          return true;
        }

        // Wait a bit more and check again — Meet UI can be slow
        await delay(2000);
        if (areCaptionsActive()) {
          log('Captions verified active after extended wait');
          return true;
        }

        log('Clicked caption button but captions did not activate, continuing');
        // Don't return true — the click may have opened a dropdown instead
      }
    }

    // Also try clicking icon-based caption buttons (closed_caption icon)
    const ccIconBtn = findIconButton('closed_caption');
    if (ccIconBtn) {
      log('Found closed_caption icon button, clicking');
      await clickAndWait(ccIconBtn, 1000);
      await delay(2000);
      if (areCaptionsActive()) {
        log('Captions verified active after icon button click');
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

  function onCaptionsConfirmed(): void {
    captionAutoEnabled = true;
    hideCaptionOverlay();
    startParticipantScanner();
  }

  async function autoEnableCaptions(retries = 3): Promise<void> {
    if (captionAutoEnabled) return;

    for (let attempt = 0; attempt < retries; attempt++) {
      log(`Auto-enable captions attempt ${attempt + 1}/${retries}`);

      if (areCaptionsActive()) {
        log('Captions already active');
        onCaptionsConfirmed();
        return;
      }

      if (await tryDirectCaptionButton()) {
        onCaptionsConfirmed();
        return;
      }

      if (await tryMenuCaptionEnable()) {
        onCaptionsConfirmed();
        return;
      }

      await delay(3000);
    }

    log('Could not auto-enable captions after', retries, 'attempts');
  }

  function isMeetingJoined(): boolean {
    // Check for call-ended screen — if present, we're not in a meeting
    if (document.querySelector('[data-call-ended]')) return false;

    // Strategy 1: standard button labels
    if (findButtonByLabel('microphone') || findButtonByLabel('camera') || findIconButton('mic')) {
      return true;
    }

    // Strategy 2: icon-based buttons (mic, videocam)
    if (findIconButton('mic') || findIconButton('mic_off') || findIconButton('videocam') || findIconButton('videocam_off')) {
      return true;
    }

    // Strategy 3: meeting-specific DOM markers
    if (document.querySelector('[data-self-name]') || document.querySelector('[data-participant-id]')) {
      return true;
    }

    // Strategy 4: button labels in other languages (mute/unmute patterns)
    if (findButtonByLabel('mute') || findButtonByLabel('unmute')) {
      return true;
    }

    return false;
  }

  // Inject hiding CSS early
  if (document.head) {
    hideCaptionOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', hideCaptionOverlay);
  }

  // Auto-enable captions once meeting is joined.
  // Keep the interval running until captions are confirmed active so that
  // transient UI-timing failures don't permanently prevent auto-enable.
  let autoEnableCheckInterval: ReturnType<typeof setInterval> | null = null;
  let autoEnableInProgress = false;

  function checkAndAutoEnable(): void {
    if (isContextInvalidated()) {
      if (autoEnableCheckInterval) {
        clearInterval(autoEnableCheckInterval);
        autoEnableCheckInterval = null;
      }
      return;
    }
    if (captionAutoEnabled) {
      if (autoEnableCheckInterval) {
        clearInterval(autoEnableCheckInterval);
        autoEnableCheckInterval = null;
      }
      return;
    }
    if (isMeetingJoined() && !autoEnableInProgress) {
      autoEnableInProgress = true;
      log('Meeting joined detected, will auto-enable captions');
      setTimeout(() => {
        autoEnableCaptions(3).finally(() => { autoEnableInProgress = false; });
      }, 2000);
    }
  }

  autoEnableCheckInterval = setInterval(checkAndAutoEnable, 10000);
  // Run fast initial checks
  setTimeout(checkAndAutoEnable, 2000);
  setTimeout(checkAndAutoEnable, 5000);

  // Listen for retry requests from the service worker (sent when no caption
  // data arrives for a while despite having an active meeting).
  chrome.runtime.onMessage.addListener((message): undefined => {
    if (message.type === MSG_RETRY_CAPTIONS) {
      log('Service worker requested caption retry');
      captionAutoEnabled = false;
      autoEnableInProgress = false;
      // Re-start the check interval if it was cleared
      if (!autoEnableCheckInterval) {
        autoEnableCheckInterval = setInterval(checkAndAutoEnable, 10000);
      }
      // Trigger immediately
      setTimeout(checkAndAutoEnable, 500);
    }
  });
})();
