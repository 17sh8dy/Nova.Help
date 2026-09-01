import { feedbackCategory, otherCategory } from '../shared.js';

/**
 * Nova Engine — the C++ engine. Its audience is developers, so there is no account category:
 * nobody signs in to an engine. Categories map to the layers a developer would name in a bug
 * report.
 */
export const project = {
  id: 'nova-engine',
  name: 'Nova Engine',
  blurb: 'The engine underneath — building it, running it, rendering, physics and audio.',
  kind: 'Engine & SDK',
  audience: 'developer',
  icon: 'cube',
  environment: {
    collect: true,
    versionLabel: 'Engine version or commit',
    versionHint: 'A commit hash is more useful than a version here.',
    platforms: ['Windows', 'Linux', 'macOS'],
  },
  categories: [
    {
      id: 'build',
      label: 'Building the engine',
      blurb: 'CMake, toolchains, dependencies and compile errors.',
      icon: 'wrench',
      issueTypes: [
        { id: 'configure-fails', label: 'CMake configure fails', priorityMode: 'ask', priority: 'normal' },
        { id: 'compile-error', label: 'The build fails to compile', blurb: 'Paste the first error, not the last.', priorityMode: 'ask', priority: 'normal' },
        { id: 'dependency', label: 'A dependency will not resolve', priorityMode: 'ask', priority: 'normal' },
        { id: 'tests-fail', label: 'The test suite fails', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'runtime',
      label: 'Runtime & crashes',
      blurb: 'The engine starts, then misbehaves.',
      icon: 'flag',
      issueTypes: [
        { id: 'crash', label: 'The runtime crashes', blurb: 'Include the stack trace if you have one.', priorityMode: 'ask', priority: 'high', articles: ['collect-logs'] },
        { id: 'hang', label: 'It hangs or deadlocks', priorityMode: 'ask', priority: 'high' },
        { id: 'performance', label: 'Frame time or memory use is unexpected', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'rendering',
      label: 'Rendering',
      blurb: 'Shaders, lighting, shadows, weather and anything on screen.',
      icon: 'sun',
      issueTypes: [
        { id: 'visual-artifact', label: 'A visual artefact or corruption', blurb: 'A screenshot is worth a paragraph here.', priorityMode: 'ask', priority: 'normal' },
        { id: 'shader-compile', label: 'A shader fails to compile', priorityMode: 'ask', priority: 'normal' },
        { id: 'device-support', label: 'It will not run on my GPU', priorityMode: 'ask', priority: 'high' },
      ],
    },
    {
      id: 'systems',
      label: 'Physics, audio & gameplay',
      blurb: 'Simulation, sound and the gameplay layers.',
      icon: 'wave',
      issueTypes: [
        { id: 'physics', label: 'Physics behaves incorrectly', priorityMode: 'ask', priority: 'normal' },
        { id: 'audio', label: 'Audio is missing or wrong', priorityMode: 'ask', priority: 'normal' },
        { id: 'input', label: 'Input or character control is wrong', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    {
      id: 'docs',
      label: 'API & documentation',
      blurb: 'Something is undocumented, unclear or wrong in the docs.',
      icon: 'book',
      issueTypes: [
        { id: 'docs-wrong', label: 'The documentation is wrong or out of date', priorityMode: 'fixed', priority: 'low' },
        { id: 'docs-missing', label: 'Something is undocumented', priorityMode: 'fixed', priority: 'low' },
        { id: 'api-question', label: 'How do I do X with the API?', priorityMode: 'ask', priority: 'normal' },
      ],
    },
    feedbackCategory(),
    otherCategory(),
  ],
};
