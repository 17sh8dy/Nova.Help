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

  /* ── Code Slots ────────────────────────────────────────────────────────────────────────
     Progressive enhancement over ONE real <input> (see server/views/components.mjs
     `codeSlots()`). That input stays the only thing a screen reader or a keyboard user
     interacts with, and the only value that reaches the form; the row of boxes below it is
     a decorative, `aria-hidden` readout kept in sync with the input's value. Because it is
     still one text field, paste, backspace and slot-to-slot typing all work exactly as they
     would on a plain input — nothing here reimplements them, which is where per-character
     input designs usually grow bugs. Nothing here decides whether a code is right, either:
     that check is `normalizeUserCode(typed) !== normalizeUserCode(code)` in
     server/deviceRoutes.mjs, and it runs whether or not this script ever loads. */
  for (const wrapper of document.querySelectorAll('[data-code-slots]')) {
    const input = wrapper.querySelector('.code-slots__input');
    const display = wrapper.querySelector('.code-slots__display');
    const slots = display ? [...display.querySelectorAll('.code-slots__slot')] : [];
    if (!input || !display || !slots.length) continue;

    const length = slots.length;

    /* Cosmetic only — mirrors packages/nova-accounts/deviceCodes.mjs `normalizeUserCode`
       for DISPLAY, so a slot shows the character the server will actually compare. The
       server performs the real comparison; this never decides anything. */
    const foldForDisplay = (value) =>
      String(value ?? '')
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');

    let previousLength = 0;

    const render = () => {
      const folded = foldForDisplay(input.value).slice(0, length);
      const activeIndex = Math.min(folded.length, length - 1);
      const arrivedThisPass = folded.length - previousLength;
      const batchStart = folded.length - Math.max(arrivedThisPass, 0);

      slots.forEach((slot, index) => {
        const char = folded[index] ?? '';
        const wasFilled = slot.dataset.filled === 'true';

        if (char) {
          slot.textContent = char;
          slot.dataset.filled = 'true';
          if (!wasFilled) {
            /* More than one new character arrived in this pass — a paste or an autofill —
               so let it cascade in with a small stagger. A single typed key gets none,
               so ordinary typing still feels instant. */
            const staggered = arrivedThisPass > 1 && index >= batchStart;
            slot.style.animationDelay = staggered ? `${(index - batchStart) * 30}ms` : '0ms';
          }
        } else {
          slot.textContent = '';
          delete slot.dataset.filled;
          slot.style.animationDelay = '';
        }

        if (document.activeElement === input && index === activeIndex) slot.dataset.active = 'true';
        else delete slot.dataset.active;
      });

      previousLength = folded.length;
    };

    input.addEventListener('input', () => {
      // A fresh attempt: stop treating this as the failed one the page loaded with.
      wrapper.classList.remove('code-slots--error', 'code-slots--draining');
      render();
    });
    input.addEventListener('focus', render);
    input.addEventListener('blur', render);

    render();
    wrapper.classList.add('code-slots--ready');

    /* The server rendered this page WITH an error: what was typed did not match. The field
       is already blank (the server never re-sends a rejected code), so there is nothing
       real to show draining — every slot is marked filled for one frame so the drain has
       something to drain, then, a frame later, told to drain. The rAF gap is what makes the
       two states two separate paints instead of one instantaneous jump. */
    if (wrapper.dataset.slotsError === '1') {
      wrapper.classList.add('code-slots--error');
      for (const slot of slots) {
        slot.dataset.filled = 'true';
        slot.style.animationDelay = '';
      }
      requestAnimationFrame(() => wrapper.classList.add('code-slots--draining'));
    }

    /* Locked while the request is in flight — a plain "please wait", not a claim that the
       code was right. This form does a normal POST and the server answers with either a
       redirect (success) or this same page re-rendered with an error, so there is no
       client-side moment that actually knows which one is coming; showing a "success" wash
       here would be guessing. A wrong code ends up in this same dimmed state too, until the
       re-rendered page (and the error branch above) replaces it. */
    const form = input.closest('form');
    if (form) form.addEventListener('submit', () => wrapper.classList.add('code-slots--submitting'));
  }
})();
