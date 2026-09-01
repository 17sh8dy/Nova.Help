import { accountCategory, feedbackCategory, otherCategory } from '../shared.js';

/** Open Cut — the editor. Export is the category that generates the most tickets, so it leads. */
export const project = {
  id: 'open-cut',
  name: 'Open Cut',
  blurb: 'The video editor and photo editor — import, timeline, effects and export.',
  kind: 'Desktop app',
  icon: 'film',
  environment: {
    collect: true,
    versionLabel: 'Open Cut version',
    versionHint: 'Help -> About shows the exact build.',
    platforms: ['Windows', 'macOS', 'Linux'],
  },
  categories: [
    {
      id: 'install',
      label: 'Install & setup',
      blurb: 'Installing, updating and first run.',
      icon: 'download',
      issueTypes: [
        { id: 'install-fails', label: "Open Cut won't install", priorityMode: 'ask', priority: 'high' },
        { id: 'wont-start', label: "Open Cut won't start", priorityMode: 'ask', priority: 'high', articles: ['collect-logs'] },
        {
          id: 'ffmpeg',
          label: 'It asks for FFmpeg, or export tools are missing',
          priorityMode: 'ask',
          priority: 'normal',
          articles: ['opencut-ffmpeg'],
        },
        { id: 'security-warning', label: 'Windows or macOS warns about the download', priorityMode: 'ask', priority: 'low' },
      ],
    },
    {
      id: 'media',
      label: 'Media & import',
      blurb: 'Getting footage, audio and images into a project.',
      icon: 'import',
      issueTypes: [
        { id: 'import-fails', label: "A file won't import", blurb: 'Tell us the format and where it came from.', priorityMode: 'ask', priority: 'normal' },
        { id: 'preview-black', label: 'Preview is black, frozen or out of sync', priorityMode: 'ask', priority: 'high' },
        { id: 'media-offline', label: 'Media shows as missing or offline', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'editing',
      label: 'Timeline & editing',
      blurb: 'Cutting, moving, selecting and playback.',
      icon: 'timeline',
      issueTypes: [
        { id: 'timeline-behaviour', label: 'A timeline action does the wrong thing', priorityMode: 'ask', priority: 'normal' },
        { id: 'playback', label: 'Playback stutters or will not start', priorityMode: 'ask', priority: 'normal' },
        { id: 'lost-work', label: 'I lost work, or a project will not open', priorityMode: 'fixed', priority: 'urgent' },
      ],
    },
    {
      id: 'effects',
      label: 'Effects & text',
      blurb: 'Filters, text animations and the photo editor.',
      icon: 'spark',
      issueTypes: [
        { id: 'effect-not-applying', label: 'An effect or filter does nothing', priorityMode: 'ask', priority: 'normal' },
        { id: 'text-animation', label: 'A text animation renders incorrectly', priorityMode: 'ask', priority: 'normal' },
        { id: 'photo-editor', label: 'A photo editor problem', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'export',
      label: 'Export & rendering',
      blurb: 'Producing the finished file.',
      icon: 'export',
      issueTypes: [
        { id: 'export-fails', label: 'Export fails or never finishes', priorityMode: 'ask', priority: 'high', articles: ['collect-logs'] },
        { id: 'export-quality', label: 'The exported file looks or sounds wrong', blurb: 'Black frames, wrong colours, missing audio.', priorityMode: 'ask', priority: 'high' },
        { id: 'export-slow', label: 'Export is very slow', priorityMode: 'ask', priority: 'normal' },
        { id: 'export-format', label: 'I need a format or codec that is not offered', priorityMode: 'fixed', priority: 'low' },
      ],
    },
    accountCategory(),
    feedbackCategory(),
    otherCategory(),
  ],
};
