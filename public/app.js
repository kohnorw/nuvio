const $ = (id) => document.getElementById(id);
const accounts = []; // { email, accessToken, profiles:[{profileId,name,selected,status,statusKind}] }

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

/* ----------------------------------------------------------------- bundle -- */

let bundle = null;

async function loadBundle() {
  const warn = $('configWarning');
  try {
    bundle = await (await fetch('/admin/api/bundle')).json();

    if (!bundle.addonsFilePresent) {
      warn.querySelector('p').innerHTML =
        '<b>No addons configured yet.</b> Copy <code>config/addons.example.json</code> ' +
        'to <code>config/addons.json</code>, add your manifest URLs, then restart.';
      warn.hidden = false;
    }

    renderQualities();

    if (!bundle.genreFilePresent && warn.hidden) {
      warn.querySelector('p').innerHTML =
        '<b>No Genres collection yet.</b> Add <code>config/collections.genre.json</code>, then restart.';
      warn.hidden = false;
    }
  } catch {
    warn.querySelector('p').innerHTML =
      '<b>Could not read the bundle config.</b> Check the container logs.';
    warn.hidden = false;
  }
}

/* ---------------------------------------------------------------- quality -- */

let selectedQuality = null;

function renderQualities() {
  const box = $('qualityGroup');
  box.innerHTML = '';
  const qs = bundle?.qualities || [];

  // Default to the first quality that actually has a URL configured.
  selectedQuality = (qs.find((q) => q.configured) || {}).id || null;

  qs.forEach((q) => {
    const label = document.createElement('label');
    label.className = q.configured ? '' : 'off';
    if (!q.configured) label.title = `${q.label} has no manifest URL configured.`;

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'quality';
    input.value = q.id;
    input.checked = q.id === selectedQuality;
    input.disabled = !q.configured;
    input.addEventListener('change', () => {
      selectedQuality = q.id;
    });

    const span = document.createElement('span');
    span.textContent = q.label;

    label.append(input, span);
    box.appendChild(label);
  });

  const missing = qs.filter((q) => !q.configured).map((q) => q.label);
  const hint = $('qualityHint');
  if (missing.length) {
    hint.textContent =
      `${missing.join(' and ')} not configured — set AIOSTREAMS_` +
      `${missing.map((m) => m.toUpperCase().replace('.', '')).join('/')}_URL in .env.`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

/* ------------------------------------------------------------------- auth -- */

$('signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('signinBtn');
  const err = $('signinError');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const email = $('email').value.trim();
    if (accounts.some((a) => a.email.toLowerCase() === email.toLowerCase()))
      throw new Error('That account is already added.');

    const r = await post('/admin/api/signin', { email, password: $('password').value });
    accounts.push({
      email: r.email || email,
      accessToken: r.accessToken,
      profiles: r.profiles.map((p) => ({ ...p, selected: true, status: null })),
    });
    $('email').value = '';
    $('password').value = '';
    render();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

/* ------------------------------------------------------------------ board -- */

const CHECK =
  '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M1.5 6.3 4.4 9.2 10.5 3" stroke="#000" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

function render() {
  const board = $('board');
  board.innerHTML = '';

  accounts.forEach((acct, ai) => {
    const card = document.createElement('div');
    card.className = 'acct';

    const head = document.createElement('div');
    head.className = 'acct-head';

    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = (acct.email[0] || '?').toUpperCase();

    const em = document.createElement('span');
    em.className = 'acct-email';
    em.textContent = acct.email;

    const ct = document.createElement('span');
    ct.className = 'acct-count';
    ct.textContent = `${acct.profiles.length} profile${acct.profiles.length === 1 ? '' : 's'}`;

    head.append(av, em, ct);
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'profs';

    acct.profiles.forEach((p, pi) => {
      const tile = document.createElement('label');
      tile.className = 'prof' + (p.selected ? ' sel' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = p.selected;
      cb.addEventListener('change', () => {
        p.selected = cb.checked;
        tile.classList.toggle('sel', cb.checked);
      });

      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.innerHTML = CHECK;

      const name = document.createElement('span');
      name.className = 'prof-name';
      name.textContent = p.name;

      const badge = document.createElement('span');
      badge.className = 'badge' + (p.statusKind ? ' ' + p.statusKind : '');
      badge.textContent = p.status || '';
      badge.id = `st-${ai}-${pi}`;
      badge.title = p.status || '';

      tile.append(cb, tick, name, badge);
      grid.appendChild(tile);
    });

    card.appendChild(grid);
    board.appendChild(card);
  });

  const none = accounts.length === 0;
  $('step-targets').hidden = none;
  $('step-quality').hidden = none;
  $('step-apply').hidden = none;
}

function setStatus(ai, pi, text, kind) {
  const p = accounts[ai].profiles[pi];
  p.status = text;
  p.statusKind = kind;
  const el = $(`st-${ai}-${pi}`);
  if (el) {
    el.textContent = text;
    el.title = text;
    el.className = 'badge' + (kind ? ' ' + kind : '');
  }
}

function selectedTargets() {
  const out = [];
  accounts.forEach((a, ai) =>
    a.profiles.forEach((p, pi) => {
      if (p.selected) out.push({ ai, pi, acct: a, prof: p });
    })
  );
  return out;
}

/* ----------------------------------------------------------- preview/push -- */

async function runAcross(fn, label) {
  const targets = selectedTargets();
  const err = $('applyError');
  err.hidden = true;

  if (!targets.length) {
    err.textContent = 'Select at least one profile.';
    err.hidden = false;
    return;
  }

  if (!selectedQuality) {
    err.textContent = 'No stream quality is configured. Set an AIOStreams URL in .env.';
    err.hidden = false;
    return;
  }

  $('previewBtn').disabled = true;
  $('applyBtn').disabled = true;

  // Sequential: keeps the board readable and avoids hammering the API.
  for (const t of targets) {
    setStatus(t.ai, t.pi, label, 'run');
    try {
      await fn(t);
    } catch (e) {
      setStatus(t.ai, t.pi, e.message, 'err');
    }
  }

  $('previewBtn').disabled = false;
  $('applyBtn').disabled = false;
}

$('previewBtn').addEventListener('click', () =>
  runAcross(async (t) => {
    const r = await post('/admin/api/preview', {
      accessToken: t.acct.accessToken,
      profileId: t.prof.profileId,
      quality: selectedQuality,
    });
    const bits = [];
    if (r.addonsRemoved.length)
      bits.push(`removes ${r.addonsRemoved.length}: ${r.addonsRemoved.join(', ')}`);
    if (r.addonsAdded.length) bits.push(`adds ${r.addonsAdded.length} addon`);
    if (r.collectionsRemoved) bits.push(`replaces ${r.collectionsRemoved} coll`);
    if (r.collectionOrder?.length) bits.push(`layout: ${r.collectionOrder.join(' → ')}`);
    setStatus(t.ai, t.pi, bits.length ? bits.join(' · ') : 'already clean', 'info');
  }, 'reading…')
);

$('applyBtn').addEventListener('click', () => {
  const n = selectedTargets().length;
  if (n && !confirm(
    `Clean install on ${n} profile(s).\n\n` +
    'Every addon not in the bundle will be REMOVED, and all existing ' +
    'collections will be replaced.\n\nThis cannot be undone. Continue?'
  )) return;

  runAcross(async (t) => {
    const r = await post('/admin/api/apply', {
      accessToken: t.acct.accessToken,
      profileId: t.prof.profileId,
      quality: selectedQuality,
    });
    setStatus(t.ai, t.pi, r.log.join(' · '), 'ok');
  }, 'pushing…');
});

loadBundle();
