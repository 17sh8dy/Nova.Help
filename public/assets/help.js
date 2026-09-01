/**
 * Progressive enhancement. Nothing here is required for the portal to work.
 *
 * The guided flow is links and the ticket form is a normal multipart POST, so with this file
 * blocked, missing or broken, every page still functions. What it adds is the feedback a form
 * this long should give while you are filling it in:
 *
 *   - a character count that appears only as you approach the limit
 *   - the list of files you picked, with sizes, checked against the same limits the server
 *     enforces — the check is a courtesy, the server's is the real one
 *   - a submit button that says it is working, so a slow upload does not get clicked twice
 *   - focus moved to the error summary after a failed submit
 *
 * It touches nothing else. No routing, no fetch, no state.
 */
(() => {
  'use strict';

  const LIMITS = { maxFiles: 5, maxBytesPerFile: 10 * 1024 * 1024, maxBytesTotal: 25 * 1024 * 1024 };

  const humanSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  /* ── Error summary ─────────────────────────────────────────────────────────────────────
     The server renders it with role="alert"; moving focus to it means a keyboard user lands
     on the problem instead of at the top of a re-rendered page. */
  const summary = document.getElementById('error-summary');
  if (summary) summary.focus();

  /* ── Character counters ────────────────────────────────────────────────────────────────
     Silent until 80% of the limit, because a counter that is always on reads as a demand for
     brevity, and this form wants detail. */
  for (const field of document.querySelectorAll('.input[maxlength]')) {
    const max = Number(field.getAttribute('maxlength'));
    if (!Number.isFinite(max) || max < 40) continue;

    const counter = document.createElement('p');
    counter.className = 'field__note';
    counter.setAttribute('aria-live', 'polite');
    counter.hidden = true;
    field.insertAdjacentElement('afterend', counter);

    const update = () => {
      const used = field.value.length;
      const near = used >= max * 0.8;
      counter.hidden = !near;
      if (near) counter.textContent = `${max - used} characters left`;
    };

    field.addEventListener('input', update);
    update();
  }

  /* ── Attachment preview ────────────────────────────────────────────────────────────────
     Shows what was picked and flags anything the server would reject, before the upload is
     spent. The input is never cleared automatically: silently dropping someone's file is
     worse than telling them it will not be accepted. */
  const fileInput = document.getElementById('files');
  const fileList = document.querySelector('[data-file-list]');

  if (fileInput && fileList) {
    fileInput.addEventListener('change', () => {
      const files = [...fileInput.files];
      if (!files.length) {
        fileList.hidden = true;
        fileList.textContent = '';
        return;
      }

      const total = files.reduce((sum, file) => sum + file.size, 0);
      const problems = [];
      if (files.length > LIMITS.maxFiles) problems.push(`Only ${LIMITS.maxFiles} files can be sent.`);
      for (const file of files) {
        if (file.size > LIMITS.maxBytesPerFile) problems.push(`${file.name} is over ${humanSize(LIMITS.maxBytesPerFile)}.`);
      }
      if (total > LIMITS.maxBytesTotal) problems.push(`Together they are over ${humanSize(LIMITS.maxBytesTotal)}.`);

      const names = files.map((file) => `${file.name} (${humanSize(file.size)})`).join(', ');
      fileList.hidden = false;
      fileList.textContent = problems.length ? `${names} — ${problems.join(' ')}` : `${names} — ${humanSize(total)} total`;
      fileList.classList.toggle('field__error', problems.length > 0);
    });
  }

  /* ── Submit state ──────────────────────────────────────────────────────────────────────
     A ticket with attachments can take a few seconds to upload. The button is disabled after
     the browser has begun submitting, never before, so an invalid form can still be resubmitted
     and nothing is ever blocked by script alone. */
  for (const form of document.querySelectorAll('form[method="post"]')) {
    form.addEventListener('submit', () => {
      const button = form.querySelector('button[type="submit"]');
      if (!button) return;
      // Let the submission start before the button is disabled; a disabled button is not
      // included in the request, and disabling it synchronously can cancel the submit.
      setTimeout(() => {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        const label = button.querySelector('span');
        if (label) label.textContent = 'Sending…';
      }, 0);
    });
  }
})();
