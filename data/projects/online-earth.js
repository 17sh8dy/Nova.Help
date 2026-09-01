import { accountCategory, feedbackCategory, otherCategory } from '../shared.js';

/**
 * Online Earth — the spatial platform. The category split follows what a person would say out
 * loud ("the globe won't load", "Navigator isn't answering"), not the codebase's module names.
 */
export const project = {
  id: 'online-earth',
  name: 'Online Earth',
  blurb: 'The interactive globe, Navigator, the Hub and everything built on them.',
  kind: 'Web & desktop app',
  icon: 'globe',
  environment: {
    collect: true,
    versionLabel: 'Online Earth version',
    versionHint: 'Settings -> About, if you know it.',
    platforms: ['Windows', 'macOS', 'Linux', 'Web browser'],
  },
  categories: [
    {
      id: 'globe',
      label: 'Globe & maps',
      blurb: 'Rendering, imagery, terrain, camera and search on the globe.',
      icon: 'globe',
      issueTypes: [
        {
          id: 'globe-not-loading',
          label: "The globe isn't loading",
          blurb: 'A blank, black or endlessly loading globe.',
          priorityMode: 'ask',
          priority: 'high',
          articles: ['webgl-check', 'clear-cache'],
        },
        {
          id: 'imagery-missing',
          label: 'Imagery or terrain looks wrong',
          blurb: 'Blurry tiles, missing terrain, or places that never sharpen.',
          priorityMode: 'ask',
          priority: 'normal',
        },
        {
          id: 'search-results',
          label: "Search can't find a place",
          priorityMode: 'ask',
          priority: 'normal',
        },
        {
          id: 'globe-performance',
          label: 'The globe is slow or stutters',
          priorityMode: 'ask',
          priority: 'normal',
          articles: ['webgl-check'],
        },
        {
          id: 'camera-controls',
          label: 'Camera or controls behave oddly',
          priorityMode: 'ask',
          priority: 'normal',
        },
      ],
    },
    {
      id: 'navigator',
      label: 'Navigator',
      blurb: 'The in-app assistant: answers, voice, memory and automation.',
      icon: 'spark',
      issueTypes: [
        {
          id: 'navigator-no-response',
          label: "Navigator doesn't respond",
          priorityMode: 'ask',
          priority: 'high',
        },
        {
          id: 'navigator-wrong-answer',
          label: 'Navigator gave a wrong or unhelpful answer',
          blurb: 'Include what you asked and what it said.',
          priorityMode: 'ask',
          priority: 'normal',
        },
        {
          id: 'navigator-actions',
          label: "Navigator won't perform an action",
          blurb: 'It understood, but nothing happened in the app.',
          priorityMode: 'ask',
          priority: 'normal',
        },
      ],
    },
    {
      id: 'settings',
      label: 'Settings & appearance',
      blurb: 'Preferences, themes, effects and profiles.',
      icon: 'sliders',
      issueTypes: [
        {
          id: 'setting-not-saving',
          label: "A setting won't save",
          priorityMode: 'ask',
          priority: 'normal',
        },
        {
          id: 'appearance',
          label: 'Theme or visual effects look wrong',
          priorityMode: 'ask',
          priority: 'low',
        },
        {
          id: 'profile-data',
          label: 'Favourites, history or progress disappeared',
          priorityMode: 'ask',
          priority: 'high',
        },
      ],
    },
    {
      id: 'hub-apps',
      label: 'Hub & apps',
      blurb: 'The Hub, All Tools and the apps that run inside Online Earth.',
      icon: 'grid',
      issueTypes: [
        {
          id: 'app-wont-open',
          label: "A tool or app won't open",
          priorityMode: 'ask',
          priority: 'normal',
        },
        {
          id: 'app-broken',
          label: 'A tool or app is broken',
          priorityMode: 'ask',
          priority: 'normal',
        },
        {
          id: 'achievements',
          label: 'Achievements or progress look wrong',
          priorityMode: 'ask',
          priority: 'low',
        },
      ],
    },
    accountCategory(),
    feedbackCategory(),
    otherCategory(),
  ],
};
