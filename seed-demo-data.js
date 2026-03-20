/**
 * MeetScribe – Demo data seed script
 *
 * HOW TO USE:
 *   1. Go to chrome://extensions and enable Developer Mode
 *   2. Find MeetScribe → click "Service Worker" link → DevTools opens
 *   3. Paste this entire script into the Console and press Enter
 *   4. Open the MeetScribe popup — you'll see the demo meetings
 *
 * To clear demo data, run:
 *   chrome.storage.local.remove('meetings')
 */

(async () => {
  const now = Date.now();
  const h = (hours) => now - hours * 60 * 60 * 1000;
  const m = (base, minutes) => base + minutes * 60 * 1000;

  const meetings = {
    'meeting-demo-1': {
      id: 'meeting-demo-1',
      meetingCode: 'abc-defg-hij',
      title: 'Q2 Product Planning',
      description: 'Sarah Chen, Marcus Reid, Priya Sharma',
      startTime: h(0.4),
      endTime: null, // live meeting
      participants: {
        'device-1': 'Sarah Chen',
        'device-2': 'Marcus Reid',
        'device-3': 'Priya Sharma',
      },
      entries: [
        { id: 'e1-1', speaker: 'Sarah Chen',  timestamp: m(h(0.4), 3),  text: "Alright, let's get started. Today we're planning the Q2 roadmap — main focus is the new onboarding flow and the analytics dashboard." },
        { id: 'e1-2', speaker: 'Marcus Reid', timestamp: m(h(0.4), 4),  text: "I've pushed the initial designs for onboarding. Main change is we're moving account setup to after the first 'aha moment' instead of right at signup." },
        { id: 'e1-3', speaker: 'Priya Sharma', timestamp: m(h(0.4), 6), text: "That matches what we saw in user research — people dropped off when they had to fill in company details before seeing any value." },
        { id: 'e1-4', speaker: 'Sarah Chen',  timestamp: m(h(0.4), 8),  text: "Agreed. Marcus, can you share the timeline? How long until we have a testable prototype?" },
        { id: 'e1-5', speaker: 'Marcus Reid', timestamp: m(h(0.4), 9),  text: "End of next week for a clickable prototype. Engineering would need another two weeks on top of that for a functional build." },
        { id: 'e1-6', speaker: 'Priya Sharma', timestamp: m(h(0.4), 11), text: "That works. We should run a quick usability study as soon as the prototype is ready — I can set up 5 sessions within two days of getting access." },
        { id: 'e1-7', speaker: 'Sarah Chen',  timestamp: m(h(0.4), 13), text: "Perfect. Let's also make sure we're tracking activation rate as the primary metric — users who complete their first project within 24 hours." },
        { id: 'e1-8', speaker: 'Marcus Reid', timestamp: m(h(0.4), 15), text: "On the analytics dashboard — are we doing a full rebuild or iterating on what we have? The current one is pretty slow past 10k events." },
        { id: 'e1-9', speaker: 'Priya Sharma', timestamp: m(h(0.4), 17), text: "We should rebuild the backend queries at minimum. The UI can stay for now — a full redesign is a Q3 thing." },
      ],
    },

    'meeting-demo-2': {
      id: 'meeting-demo-2',
      meetingCode: 'klm-nopq-rst',
      title: 'Design Review – Onboarding Flow',
      description: 'Lena Volkov, James Okafor',
      startTime: h(1.8),
      endTime: h(1.8) + 47 * 60 * 1000,
      participants: {
        'device-4': 'Lena Volkov',
        'device-5': 'James Okafor',
      },
      entries: [
        { id: 'e2-1', speaker: 'Lena Volkov',  timestamp: m(h(1.8), 2),  text: "I've updated the Figma file with the new onboarding screens. The main change is a three-step setup wizard instead of the old single-page form." },
        { id: 'e2-2', speaker: 'James Okafor', timestamp: m(h(1.8), 4),  text: "Looks much cleaner. Did you keep the progress indicator at the top? That was something users said they liked in the last round of research." },
        { id: 'e2-3', speaker: 'Lena Volkov',  timestamp: m(h(1.8), 5),  text: "Yes, it's still there. I also added micro-animations on step transitions to make it feel more polished without being distracting." },
        { id: 'e2-4', speaker: 'James Okafor', timestamp: m(h(1.8), 8),  text: "The colors on step 2 feel a bit off — the gray background with the blue button isn't enough contrast on mobile screens." },
        { id: 'e2-5', speaker: 'Lena Volkov',  timestamp: m(h(1.8), 10), text: "Good catch. I'll increase the button contrast ratio to at least 4.5:1 to meet WCAG AA. Can you check the Figma comments I left on that screen?" },
      ],
    },

    'meeting-demo-3': {
      id: 'meeting-demo-3',
      meetingCode: 'uvw-xyza-bcd',
      title: 'Engineering Sync',
      description: 'Marcus Reid, Tomasz Wiśniewski, Sarah Chen',
      startTime: h(26),
      endTime: h(26) + 31 * 60 * 1000,
      participants: {
        'device-2': 'Marcus Reid',
        'device-6': 'Tomasz Wiśniewski',
        'device-1': 'Sarah Chen',
      },
      entries: [
        { id: 'e3-1', speaker: 'Tomasz Wiśniewski', timestamp: m(h(26), 1), text: "Quick heads up — the CI pipeline is failing on the new DB migration. Looks like a column name conflict with the existing schema." },
        { id: 'e3-2', speaker: 'Marcus Reid',       timestamp: m(h(26), 3), text: "I saw that. The migration script is running before the index is dropped. I'll fix the ordering — should be a one-line change." },
        { id: 'e3-3', speaker: 'Sarah Chen',         timestamp: m(h(26), 5), text: "While we're here — the load tests showed some latency spikes around the 500 concurrent users mark. Any idea what's causing it?" },
        { id: 'e3-4', speaker: 'Tomasz Wiśniewski', timestamp: m(h(26), 7), text: "Most likely the connection pool. We're hitting the limit under sustained load. I'd suggest bumping it from 20 to 50 and re-running the tests." },
        { id: 'e3-5', speaker: 'Marcus Reid',       timestamp: m(h(26), 9), text: "Agreed. I'll open a PR for both fixes today. Should be mergeable by EOD." },
      ],
    },

    'meeting-demo-4': {
      id: 'meeting-demo-4',
      meetingCode: 'efg-hijk-lmn',
      title: 'Investor Update – Series B',
      description: 'Priya Sharma, Lena Volkov, David Park',
      startTime: h(74),
      endTime: h(74) + 58 * 60 * 1000,
      participants: {
        'device-3': 'Priya Sharma',
        'device-4': 'Lena Volkov',
        'device-7': 'David Park',
      },
      entries: [
        { id: 'e4-1', speaker: 'Priya Sharma', timestamp: m(h(74), 2),  text: "We closed Q1 at $2.4M ARR, up 38% quarter-over-quarter. The main driver was expansion revenue from our enterprise tier." },
        { id: 'e4-2', speaker: 'David Park',   timestamp: m(h(74), 5),  text: "That's a strong signal. What's the net revenue retention looking like for that cohort?" },
        { id: 'e4-3', speaker: 'Priya Sharma', timestamp: m(h(74), 6),  text: "NRR is at 118% for enterprise. SMB is slightly lower at 104%, but churn has dropped from 3.2% to 1.8% since we launched the new onboarding." },
        { id: 'e4-4', speaker: 'Lena Volkov',  timestamp: m(h(74), 10), text: "We're planning to double down on the enterprise segment in Q2 — dedicated success managers and a self-serve admin portal." },
        { id: 'e4-5', speaker: 'David Park',   timestamp: m(h(74), 13), text: "Makes sense. The unit economics on enterprise are clearly better. What's the current CAC payback period?" },
        { id: 'e4-6', speaker: 'Priya Sharma', timestamp: m(h(74), 15), text: "About 9 months for enterprise, which we expect to bring down to 7 months by Q3 as we optimize the sales cycle." },
      ],
    },

    'meeting-demo-5': {
      id: 'meeting-demo-5',
      meetingCode: 'opq-rstu-vwx',
      title: '1:1 with Sarah',
      description: 'Sarah Chen',
      startTime: h(98),
      endTime: h(98) + 25 * 60 * 1000,
      participants: {
        'device-1': 'Sarah Chen',
      },
      entries: [
        { id: 'e5-1', speaker: 'Sarah Chen', timestamp: m(h(98), 2),  text: "Let's start with where you're at on the dashboard project. Any blockers?" },
        { id: 'e5-2', speaker: 'Sarah Chen', timestamp: m(h(98), 8),  text: "That makes sense. I'll work with the data team to get you read access to the staging environment by Thursday." },
        { id: 'e5-3', speaker: 'Sarah Chen', timestamp: m(h(98), 15), text: "On the career side — you mentioned wanting to move toward a tech lead role. Let's plan a structured project for Q2 that gives you that experience." },
      ],
    },
  };

  await chrome.storage.local.set({ meetings });
  console.log('✅ Demo data saved. Reloading extension…');
  chrome.runtime.reload();
})();
