// ==== SETTINGS: registry + panel UI + localStorage persistence ====
// Feature files call Settings.define(...) at load; main.js calls Settings.init()
// once at the end of its script (all definitions registered by then) to apply
// stored values and build the panel. Panel toggles with P / closes with Esc.
const Settings = (function () {
  const STORAGE_KEY = 'ascii-city-settings';
  const defs = new Map();            // id -> { def, onChange, value, ui }
  let panel = null, open = false, wired = false;
  let storageOk = (function () {     // localStorage can throw (privacy mode) or be absent
    try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (e) { return false; }
  })();

  function clampDef(def, v) {
    if (def.type === 'range') {
      const n = Number(v);
      if (!isFinite(n)) return null;
      return Math.min(def.max, Math.max(def.min, n));
    }
    if (def.type === 'checkbox') return !!v;
    return v;
  }

  function updateUI(e) {
    const ui = e.ui;
    if (!ui) return;
    if (ui.inp && e.def.type === 'range') {
      ui.inp.value = String(e.value);
      ui.val.textContent = e.def.fmt ? e.def.fmt(e.value) : String(e.value);
    } else if (ui.inp && e.def.type === 'checkbox') {
      ui.inp.checked = !!e.value;
    } else if (ui.sel) {
      ui.sel.value = String(e.value);
    }
  }

  function save() {
    if (!storageOk) return;
    try {
      const o = {};
      defs.forEach((e, id) => { o[id] = e.value; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
    } catch (err) { storageOk = false; }
  }

  function define(id, def, onChange) {
    const v = clampDef(def, def.default);
    const e = { def, onChange, value: v === null ? def.default : v, ui: null };
    defs.set(id, e);
    return e.value;
  }

  function get(id) {
    const e = defs.get(id);
    return e ? e.value : undefined;
  }

  function set(id, v, opts) {
    const e = defs.get(id);
    if (!e) return false;
    const nv = clampDef(e.def, v);
    if (nv === null) return false;
    const changed = nv !== e.value;
    e.value = nv;
    updateUI(e);
    if (changed && e.onChange) e.onChange(nv);
    if (changed && !(opts && opts.silent)) save();
    return changed;
  }

  function fmtVal(def, v) { return def.fmt ? def.fmt(v) : String(v); }

  function makeRow(id) {
    const e = defs.get(id), d = e.def;
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.textContent = d.label;
    row.appendChild(lab);
    if (d.type === 'range') {
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = d.min; inp.max = d.max; inp.step = d.step;
      inp.value = String(e.value);
      const val = document.createElement('span');
      val.textContent = fmtVal(d, e.value);
      val.style.minWidth = '44px'; val.style.textAlign = 'right';
      inp.addEventListener('input', () => { set(id, Number(inp.value)); });
      row.appendChild(inp); row.appendChild(val);
      e.ui = { inp, val };
    } else if (d.type === 'checkbox') {
      const inp = document.createElement('input');
      inp.type = 'checkbox'; inp.checked = !!e.value;
      inp.addEventListener('change', () => { set(id, !!inp.checked); });
      row.appendChild(inp);
      e.ui = { inp };
    } else {                                          // select
      const sel = document.createElement('select');
      for (let i = 0; i < d.options.length; i++) {
        const o = document.createElement('option');
        o.value = String(d.options[i]);
        o.textContent = fmtVal(d, d.options[i]);
        sel.appendChild(o);
      }
      sel.value = String(e.value);
      sel.addEventListener('change', () => { set(id, d.coerce ? d.coerce(sel.value) : sel.value); });
      row.appendChild(sel);
      e.ui = { sel };
    }
    return row;
  }

  function buildPanel() {
    if (panel) return;
    const p = document.createElement('div');
    p.id = 'settings-panel';
    const h = document.createElement('h3');
    h.textContent = 'SETTINGS';
    p.appendChild(h);
    defs.forEach((e, id) => { p.appendChild(makeRow(id)); });
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'P / Esc to close';
    p.appendChild(hint);
    p.style.display = 'none';
    if (document.body) document.body.appendChild(p);
    panel = p;
  }

  function refresh() { defs.forEach(e => updateUI(e)); }

  function toggle(force) {
    open = force === undefined ? !open : !!force;
    buildPanel();
    if (open) refresh();                                 // e.g. show the current clock
    if (panel) panel.style.display = open ? 'block' : 'none';
    if (!open) {                                       // never leave focus inside a hidden panel
      defs.forEach(e => { if (e.ui && e.ui.inp && e.ui.inp.blur) e.ui.inp.blur(); if (e.ui && e.ui.sel && e.ui.sel.blur) e.ui.sel.blur(); });
    }
  }

  function isOpen() { return open; }

  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') toggle(false);           // let the panel close even while an input is focused
      return;                                          // letter keys belong to selects / default behavior
    }
    const k = e.key.toLowerCase();
    if (k === 'p') { toggle(); e.preventDefault(); }
    else if (e.key === 'Escape') toggle(false);
  }

  function init() {
    if (storageOk) {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && typeof saved === 'object') defs.forEach((e, id) => { if (id in saved) set(id, saved[id], { silent: true }); });
      } catch (err) { storageOk = false; }
    }
    buildPanel();
    if (!wired) { addEventListener('keydown', onKey); wired = true; }
  }

  return { define, get, set, init, toggle, isOpen, refresh };
})();
