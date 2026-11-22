/* TraceLens reference library.
 * Your images live only on this device (IndexedDB), grouped by body region,
 * each with a label for view/angle (e.g. "dorsal", "left oblique 45°").
 * Optional built-in images come from library/index.json (read-only).
 * Needs window.TraceLens.useImage(blob) and .toast(text) from the main page.
 */
(function () {
  'use strict';
  const REGIONS = [
    ['hand', 'Hand'], ['upper', 'Upper limb'], ['lower', 'Lower limb'], ['face', 'Face'],
    ['ear', 'External ear'], ['back', 'Back'], ['trunk', 'Anterior trunk'],
    ['gm', 'Genitalia (M)'], ['gf', 'Genitalia (F)'], ['flap', 'Flaps & vessels'], ['other', 'Other']
  ];
  const RNAME = Object.fromEntries(REGIONS);
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (t, ms) => window.TraceLens && window.TraceLens.toast(t, ms);

  /* ---------- storage ---------- */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('tracelens', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('images', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('images', mode), st = t.objectStore('images'), out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Storage full?'));
    });
  }
  const allMine = () => tx('readonly', s => s.getAll());
  const putRec = r => tx('readwrite', s => s.put(r));
  const delRec = id => tx('readwrite', s => s.delete(id));
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  let builtins = [];
  fetch('library/index.json').then(r => r.ok ? r.json() : []).then(j => {
    builtins = (Array.isArray(j) ? j : []).map((b, i) => ({ id: 'b' + i, region: b.region, label: b.label, src: 'library/' + b.file, thumb: b.thumb ? 'library/' + b.thumb : '', credit: b.credit || '', builtin: true }));
    if (open) render();
  }).catch(() => {});

  /* ---------- image prep ---------- */
  function loadImg(blob) {
    return new Promise((res, rej) => { const u = URL.createObjectURL(blob), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('bad image')); }; im.src = u; });
  }
  function scaled(im, max, type, q) {
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
    return new Promise(r => c.toBlob(r, type, q));
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function addFiles(files, region) {
    let n = 0;
    for (const f of files) {
      try {
        const im = await loadImg(f), png = /png|gif|svg/.test(f.type);
        const blob = await scaled(im, 2048, png ? 'image/png' : 'image/jpeg', .92);
        const thumb = await scaled(im, 320, 'image/jpeg', .8);
        await putRec({ id: uid(), region, label: f.name.replace(/\.[^.]+$/, '').slice(0, 60), ts: Date.now(), blob, thumb });
        n++;
      } catch (e) { toast('Skipped ' + f.name + (e && /full|quota/i.test(e.message) ? ': storage full' : '')); }
    }
    if (n) toast(`Added ${n} to ${RNAME[region]}`);
    render();
  }

  /* ---------- UI ---------- */
  const css = document.createElement('style');
  css.textContent = `
#lib{position:fixed;inset:0;z-index:20;background:#0e0e10;color:#fff;display:none;flex-direction:column;font:15px/1.3 -apple-system,system-ui,sans-serif}
#lib.open{display:flex}
#lib header{display:flex;align-items:center;gap:8px;padding:12px;padding-top:max(12px,env(safe-area-inset-top))}
#lib h2{margin:0;font-size:20px;flex:1}
#lib .lb{background:#26262b;color:#fff;border:0;border-radius:10px;height:40px;padding:0 12px;font-size:14px;font-weight:600}
#lib .lb.pri{background:#4da3ff}
#lib .chips{display:flex;gap:6px;overflow-x:auto;padding:0 12px 10px;flex:none;-webkit-overflow-scrolling:touch}
#lib .chip{flex:none;background:#26262b;color:#ddd;border:0;border-radius:999px;padding:8px 12px;font-size:13px}
#lib .chip.on{background:#4da3ff;color:#fff}
#lib .chip b{opacity:.6;font-weight:500;margin-left:4px}
#lib input[type=search]{margin:0 12px 10px;background:#1c1c20;border:1px solid #333;color:#fff;border-radius:10px;padding:9px 12px;font-size:15px}
#lib .grid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:0 12px 12px;align-content:start;grid-auto-rows:max-content;touch-action:pan-y}
#lib .tile{position:relative;display:block;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:0;padding:0;margin:0}#lib .tile .ph{display:block;padding-top:133%}
#lib .tile img{position:absolute;top:4px;left:4px;width:calc(100% - 8px);height:calc(100% - 26px);object-fit:contain;display:block}
#lib .tile .cap{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.62);color:#fff;font-size:11px;padding:4px 6px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#lib .tile .more{position:absolute;top:4px;right:4px;width:30px;height:30px;border-radius:15px;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:16px;line-height:30px;padding:0}
#lib .empty{grid-column:1/-1;color:#9aa0a6;text-align:center;padding:40px 16px}
#lib footer{display:flex;gap:8px;padding:10px 12px;padding-bottom:max(10px,env(safe-area-inset-bottom));border-top:1px solid #222;flex-wrap:wrap}
#lib footer a{color:#4da3ff;font-size:13px;align-self:center;margin-left:auto}
#libEdit{position:fixed;inset:0;z-index:21;background:rgba(0,0,0,.6);display:none;align-items:flex-end;justify-content:center}
#libEdit.open{display:flex}
#libEdit .sheet{background:#1c1c20;width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:16px;padding-bottom:max(16px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:10px}
#libEdit label{font-size:12px;color:#9aa0a6}
#libEdit input,#libEdit select{background:#0e0e10;border:1px solid #333;color:#fff;border-radius:10px;padding:10px;font-size:16px;width:100%}
#libEdit .row{display:flex;gap:8px}
#libEdit .row .lb{flex:1}
#libEdit .del{background:#b3261e}`;
  document.head.appendChild(css);

  const el = document.createElement('div'); el.id = 'lib';
  el.innerHTML = `
<header><h2>Library</h2><button class="lb" id="libOnce">Use once</button><button class="lb" id="libClose">Done</button></header>
<div class="chips" id="libChips"></div>
<input type="search" id="libQ" placeholder="Search labels (e.g. dorsal, lateral)">
<div class="grid" id="libGrid"></div>
<footer><button class="lb pri" id="libAdd">+ Add images</button><a href="TraceLens_TrackingSheet_A4.pdf" target="_blank" rel="noopener">Print tracking sheet (A4 PDF)</a></footer>
<input type="file" id="libFiles" accept="image/*" multiple hidden>
<input type="file" id="libOne" accept="image/*" hidden>`;
  document.body.appendChild(el);
  const ed = document.createElement('div'); ed.id = 'libEdit';
  ed.innerHTML = `<div class="sheet">
<label>Label (view / angle)</label><input id="edLabel" maxlength="60" placeholder="e.g. Hand dorsal, right">
<label>Region</label><select id="edRegion">${REGIONS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
<div class="row"><button class="lb del" id="edDel">Delete</button><button class="lb" id="edCancel">Cancel</button><button class="lb pri" id="edSave">Save</button></div></div>`;
  document.body.appendChild(ed);

  let open = false, region = 'all', q = '', urls = [], editing = null, delArmed = false;

  async function render() {
    urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
    let mine = [];
    try { mine = await allMine(); } catch (e) { toast('Storage unavailable (private mode?)'); }
    const items = mine.sort((a, b) => b.ts - a.ts).concat(builtins);
    const count = k => items.filter(i => k === 'all' || i.region === k).length;
    $('#libChips', el).innerHTML = [['all', 'All']].concat(REGIONS).map(([k, v]) =>
      `<button class="chip${k === region ? ' on' : ''}" data-r="${k}">${v}<b>${count(k)}</b></button>`).join('');
    const ql = q.trim().toLowerCase();
    const shown = items.filter(i => (region === 'all' || i.region === region) && (!ql || (i.label + ' ' + (RNAME[i.region] || '') + ' ' + (i.credit || '')).toLowerCase().includes(ql)));
    const g = $('#libGrid', el);
    if (!shown.length) {
      g.innerHTML = `<div class="empty">${region === 'all' ? 'No images yet.' : 'No images in ' + esc(RNAME[region]) + ' yet.'}<br><br>Tap <b>+ Add images</b> to save reference diagrams here.<br>Name each with its view, e.g. "palmar", "left lateral".</div>`;
      return;
    }
    g.innerHTML = shown.map(i => {
      let src = i.thumb || i.src; if (!i.builtin) { src = URL.createObjectURL(i.thumb || i.blob); urls.push(src); }
      return `<button class="tile" data-id="${esc(i.id)}"><span class="ph"></span><img src="${src}" alt="" loading="lazy"><span class="cap">${esc(i.label || '')}${region === 'all' ? ' · ' + esc(RNAME[i.region] || '') : ''}</span>${i.builtin ? '' : '<span class="more" data-edit="1">⋯</span>'}</button>`;
    }).join('');
    g._items = Object.fromEntries(shown.map(i => [i.id, i]));
  }

  function show() { open = true; el.classList.add('open'); render(); }
  function hide() { open = false; el.classList.remove('open'); }

  $('#libChips', el).addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { region = b.dataset.r; render(); } });
  $('#libQ', el).addEventListener('input', e => { q = e.target.value; render(); });
  $('#libGrid', el).addEventListener('click', async e => {
    const t = e.target.closest('.tile'); if (!t) return;
    const it = $('#libGrid', el)._items[t.dataset.id]; if (!it) return;
    if (e.target.dataset.edit) { openEdit(it); return; }
    try {
      const blob = it.builtin ? await (await fetch(it.src)).blob() : it.blob;
      hide(); window.TraceLens.useImage(blob);
      if (it.credit) setTimeout(() => toast(it.credit, 4000), 1200);
    } catch (err) { toast('Could not open image'); }
  });
  $('#libClose', el).onclick = hide;
  $('#libAdd', el).onclick = () => $('#libFiles', el).click();
  $('#libFiles', el).onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addFiles(f, region === 'all' ? 'other' : region); };
  $('#libOnce', el).onclick = () => $('#libOne', el).click();
  $('#libOne', el).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) { hide(); window.TraceLens.useImage(f); } };

  function openEdit(it) {
    editing = it; delArmed = false; $('#edDel', ed).textContent = 'Delete';
    $('#edLabel', ed).value = it.label || ''; $('#edRegion', ed).value = it.region; ed.classList.add('open');
  }
  const closeEdit = () => { ed.classList.remove('open'); editing = null; };
  $('#edCancel', ed).onclick = closeEdit;
  ed.addEventListener('click', e => { if (e.target === ed) closeEdit(); });
  $('#edSave', ed).onclick = async () => {
    if (!editing) return;
    await putRec(Object.assign({}, editing, { label: $('#edLabel', ed).value.trim(), region: $('#edRegion', ed).value }));
    closeEdit(); render();
  };
  $('#edDel', ed).onclick = async () => {
    if (!editing) return;
    if (!delArmed) { delArmed = true; $('#edDel', ed).textContent = 'Tap again to delete'; return; }
    await delRec(editing.id); closeEdit(); render(); toast('Deleted');
  };

  window.TraceLensLibrary = { open: show, close: hide, REGIONS };
})();
