/**
 * Support articles — the knowledge base, deliberately small.
 *
 * An issue type lists article ids in its `articles` field; the guided flow shows them on the
 * step before the ticket form, and every one of them ends with a way to carry on to a person.
 * Nothing here is a substitute for support, and no article claims a product does something
 * that has not been checked — an empty `articles` list is the correct state for an issue type
 * whose fix nobody has written down yet, and renders as no self-help step at all.
 *
 * THIS IS THE CORPUS THE FUTURE ASSISTANT SEARCHES. It is a plain data collection with stable
 * ids so that adding retrieval later means indexing this file, not restructuring the portal.
 * Articles are never the authority on the decisions marked `sensitive` in the catalog.
 */
export const articles = [
  {
    id: 'webgl-check',
    title: 'Check that 3D graphics are available in your browser',
    summary:
      'The globe needs WebGL and hardware acceleration. When either is off, it stays blank or renders very slowly.',
    steps: [
      'Open a new tab and visit your browser’s WebGL report page (Chrome and Edge: chrome://gpu). If WebGL is listed as unavailable or software-only, that is the cause.',
      'Turn hardware acceleration back on in your browser settings, then restart the browser completely.',
      'Update your graphics drivers from your GPU vendor, not from Windows Update, and restart.',
      'If you are on a laptop with two GPUs, make sure the browser is allowed to use the dedicated one.',
    ],
  },
  {
    id: 'clear-cache',
    title: 'Clear cached data for a stuck page',
    summary: 'A partly downloaded asset can leave a page loading forever until its cache entry is discarded.',
    steps: [
      'Reload the page while holding Shift to bypass the cache.',
      'If that does not help, clear cached images and files for the site and reload.',
      'Try a private or incognito window. If it works there, an extension or stored data is involved.',
    ],
  },
  {
    id: 'collect-logs',
    title: 'Find the logs to attach to your ticket',
    summary:
      'A log file usually turns a two-week guess into a one-reply answer. Attach one whenever the app crashed, froze, or failed part way.',
    steps: [
      'Reproduce the problem once more, so the most recent log describes it.',
      'Close the application before copying the file, so the log is finished being written.',
      'Attach the log to your ticket rather than pasting it, and say roughly what time the problem happened.',
      'If you cannot find the log directory, say so in the ticket and we will tell you where it is for your build.',
    ],
  },
  {
    id: 'opencut-ffmpeg',
    title: 'Open Cut needs FFmpeg installed separately',
    summary:
      'FFmpeg is not bundled with Open Cut. Without it on your system, import and export of some formats will fail.',
    steps: [
      'Install FFmpeg for your platform and make sure it is on your PATH.',
      'Restart Open Cut completely so it picks up the new installation.',
      'If Open Cut still reports it as missing, open a ticket and include how you installed it.',
    ],
  },
  {
    id: 'replay-encoder',
    title: 'Encoder errors when recording',
    summary:
      'Recording uses your GPU’s hardware encoder where one is available, and falls back to the CPU where it is not. Errors here are almost always about which encoder was picked.',
    steps: [
      'Note your exact GPU model — hardware encoders differ between AMD, NVIDIA and Intel, and between generations.',
      'Update your graphics drivers and restart.',
      'Switch the encoder to a software option in settings. If that records successfully, the hardware encoder is the problem and we want to know which one.',
      'Open a ticket with your GPU model, driver version, and the exact error text.',
    ],
  },
];
