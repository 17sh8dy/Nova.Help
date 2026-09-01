import { accountCategory, feedbackCategory, otherCategory } from '../shared.js';

/** Atlas — the standalone desktop assistant. It runs locally, which shapes these categories. */
export const project = {
  id: 'atlas',
  name: 'Atlas',
  subtitle: 'Desktop Assistant',
  blurb: 'The desktop assistant — install, voice, skills and privacy.',
  kind: 'Desktop app',
  icon: 'compass',
  environment: {
    collect: true,
    versionLabel: 'Atlas version',
    versionHint: 'Shown in Settings -> About.',
    platforms: ['Windows', 'macOS', 'Linux'],
  },
  categories: [
    {
      id: 'install',
      label: 'Install & updates',
      blurb: 'Getting Atlas onto your machine and keeping it current.',
      icon: 'download',
      issueTypes: [
        { id: 'install-fails', label: "Atlas won't install", priorityMode: 'ask', priority: 'high' },
        {
          id: 'wont-start',
          label: "Atlas won't start",
          priorityMode: 'ask',
          priority: 'high',
          articles: ['collect-logs'],
        },
        { id: 'update-fails', label: 'An update failed', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'voice',
      label: 'Voice',
      blurb: 'Speech output and microphone input.',
      icon: 'mic',
      issueTypes: [
        { id: 'no-speech', label: "Atlas doesn't speak", priorityMode: 'ask', priority: 'normal' },
        {
          id: 'not-hearing',
          label: "Atlas doesn't hear me",
          blurb: 'Microphone, permissions or wake-word problems.',
          priorityMode: 'ask',
          priority: 'normal',
        },
        { id: 'voice-quality', label: 'Recognition is inaccurate', priorityMode: 'ask', priority: 'low' },
      ],
    },
    {
      id: 'skills',
      label: 'Skills & commands',
      blurb: 'What Atlas can do, and what it does when asked.',
      icon: 'spark',
      issueTypes: [
        { id: 'command-not-understood', label: 'Atlas misunderstood a command', priorityMode: 'ask', priority: 'normal' },
        { id: 'command-refused', label: 'Atlas refused something it should do', priorityMode: 'ask', priority: 'normal' },
        { id: 'skill-broken', label: 'A skill returned the wrong result', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'privacy',
      label: 'Privacy & data',
      blurb: 'What is stored on your machine, and what leaves it.',
      icon: 'shield',
      issueTypes: [
        { id: 'privacy-question', label: 'What does Atlas store or send?', priorityMode: 'fixed', priority: 'normal' },
        {
          id: 'privacy-concern',
          label: 'Report a privacy or security concern',
          priorityMode: 'fixed',
          priority: 'urgent',
          sensitive: true,
        },
      ],
    },
    accountCategory(),
    feedbackCategory(),
    otherCategory(),
  ],
};
