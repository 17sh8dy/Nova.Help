import { accountCategory, feedbackCategory, otherCategory } from '../shared.js';

/** Replay.GG — the gameplay recorder and clipper. Capture problems dominate; they lead. */
export const project = {
  id: 'replay-gg',
  name: 'Replay.GG',
  blurb: 'Gameplay recording and clipping — capture, hotkeys, clips and storage.',
  kind: 'Desktop app',
  icon: 'record',
  environment: {
    collect: true,
    versionLabel: 'Replay.GG version',
    versionHint: 'Settings -> About.',
    platforms: ['Windows'],
  },
  categories: [
    {
      id: 'capture',
      label: 'Recording & capture',
      blurb: 'Getting gameplay recorded at all.',
      icon: 'record',
      issueTypes: [
        { id: 'not-recording', label: 'Nothing is being recorded', priorityMode: 'ask', priority: 'high' },
        { id: 'game-not-detected', label: 'My game is not detected', blurb: 'Tell us the game and whether it runs full screen or windowed.', priorityMode: 'ask', priority: 'normal' },
        {
          id: 'encoder',
          label: 'Encoder or hardware acceleration errors',
          blurb: 'Messages about a missing or failing encoder.',
          priorityMode: 'ask',
          priority: 'high',
          articles: ['replay-encoder'],
        },
        { id: 'no-audio', label: 'The recording has no audio, or the wrong audio', priorityMode: 'ask', priority: 'normal' },
        { id: 'performance', label: 'Recording costs too much performance', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'clips',
      label: 'Clips & editing',
      blurb: 'Trimming, saving and exporting clips.',
      icon: 'film',
      issueTypes: [
        { id: 'clip-not-saved', label: 'A clip was not saved', priorityMode: 'ask', priority: 'high' },
        { id: 'clip-corrupt', label: 'A clip will not play, or looks corrupted', priorityMode: 'ask', priority: 'high' },
        { id: 'export-fails', label: 'Exporting a clip fails', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'hotkeys',
      label: 'Hotkeys & overlay',
      blurb: 'The in-game overlay and keyboard shortcuts.',
      icon: 'keyboard',
      issueTypes: [
        { id: 'hotkey-not-working', label: 'A hotkey does nothing in game', priorityMode: 'ask', priority: 'normal' },
        { id: 'overlay-missing', label: 'The overlay does not appear', priorityMode: 'ask', priority: 'normal' },
        { id: 'hotkey-conflict', label: 'A hotkey conflicts with my game', priorityMode: 'ask', priority: 'low' },
      ],
    },
    {
      id: 'storage',
      label: 'Storage',
      blurb: 'Where recordings live and how much space they take.',
      icon: 'drive',
      issueTypes: [
        { id: 'disk-space', label: 'Recordings are filling my disk', priorityMode: 'ask', priority: 'normal' },
        { id: 'missing-files', label: 'Recordings are missing from the folder', priorityMode: 'ask', priority: 'high' },
      ],
    },
    accountCategory(),
    feedbackCategory(),
    otherCategory(),
  ],
};
