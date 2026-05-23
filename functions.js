// ═══════════════════════════════════════════════════════
let lines = [];           // array of {el, type}
let currentLine = null;
let currentType = 'action';
let savedState = '';
let characterNames = new Set();
let sceneHeadings = new Set(['INT. ', 'EXT. ', 'INT./EXT. ', 'EXT./INT. ']);
let acIndex = -1;
let acOptions = [];
let findMatches = [];
let findIdx = 0;
let titlePageData = null;

// Undo / Redo
let undoStack = [];   // array of snapshots [{lines:[{type,text}], focusIdx}]
let redoStack = [];
let undoDebounceTimer = null;
const UNDO_MAX = 100;

// ═══════════════════════════════════════════════════════
// ELEMENT TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════
const ELEMENT_CYCLE = ['action','scene-heading','character','dialogue','parenthetical','transition','centered'];
const ELEMENT_LABELS = {
  'scene-heading': 'Scene Heading',
  'action': 'Action',
  'character': 'Character',
  'parenthetical': 'Parenthetical',
  'dialogue': 'Dialogue',
  'transition': 'Transition',
  'centered': 'Centered',
};

// after pressing Enter on a type, auto-advance to:
const NEXT_TYPE = {
  'scene-heading': 'action',
  'action': 'action',
  'character': 'dialogue',
  'parenthetical': 'dialogue',
  'dialogue': 'character',
  'transition': 'scene-heading',
  'centered': 'action',
};

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  if (lines.length === 0) addLine('scene-heading', '', true);
  updateStats();
  updateSidebar();
  pushUndo(); // initial snapshot so Ctrl+Z always has a base state

  document.getElementById('editor-wrapper').addEventListener('scroll', () => {});
  document.addEventListener('keydown', globalKeys);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#autocomplete')) hideAutocomplete();
  });
  setInterval(autoSave, 10000);
});

// ═══════════════════════════════════════════════════════
// LINE MANAGEMENT
// ═══════════════════════════════════════════════════════
function createLineEl(type, text) {
  const el = document.createElement('div');
  el.className = 'script-line';
  el.dataset.type = type;
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.innerText = text || '';
  // Accessibility
  el.setAttribute('role', 'textbox');
  el.setAttribute('aria-multiline', 'false');
  el.setAttribute('aria-label', (ELEMENT_LABELS[type] || type) + ' line. Press Tab to change element type.');
  // Apply current font size preference
  if (typeof editorFontSize !== 'undefined' && editorFontSize !== 12) {
    el.style.fontSize = editorFontSize + 'pt';
  }

  el.addEventListener('keydown', onLineKeydown);
  el.addEventListener('input', onLineInput);
  el.addEventListener('focus', onLineFocus);
  el.addEventListener('blur', onLineBlur);
  el.addEventListener('paste', onLinePaste);
  return el;
}

function addLine(type, text, focus) {
  const el = createLineEl(type, text || '');
  const page = document.getElementById('page-1');
  page.appendChild(el);
  lines.push({ el, type });
  if (focus) {
    setTimeout(() => { el.focus(); placeCursorAtEnd(el); }, 10);
  }
  return el;
}

function insertLineAfter(refEl, type, text, focus) {
  const idx = lines.findIndex(l => l.el === refEl);
  const el = createLineEl(type, text || '');
  const page = document.getElementById('page-1');
  const refEntry = lines[idx];

  if (idx >= 0 && idx < lines.length - 1) {
    page.insertBefore(el, lines[idx + 1].el);
    lines.splice(idx + 1, 0, { el, type });
  } else {
    page.appendChild(el);
    lines.push({ el, type });
  }

  if (focus) {
    setTimeout(() => { el.focus(); placeCursorAtEnd(el); }, 10);
  }
  return el;
}

function removeLine(el) {
  const idx = lines.findIndex(l => l.el === el);
  if (idx >= 0) {
    lines.splice(idx, 1);
    el.remove();
    if (lines.length > 0) {
      const newIdx = Math.max(0, idx - 1);
      lines[newIdx].el.focus();
      placeCursorAtEnd(lines[newIdx].el);
    }
  }
}

// ═══════════════════════════════════════════════════════
// KEY HANDLERS
// ═══════════════════════════════════════════════════════
function onLineKeydown(e) {
  const el = e.currentTarget;
  const type = el.dataset.type;

  // Tab: cycle element type
  if (e.key === 'Tab') {
    e.preventDefault();
    const idx = ELEMENT_CYCLE.indexOf(type);
    const next = ELEMENT_CYCLE[(idx + 1) % ELEMENT_CYCLE.length];
    changeLineType(el, next);
    hideAutocomplete();
    return;
  }

  // Enter: insert new line
  if (e.key === 'Enter') {
    e.preventDefault();
    if (acOptions.length > 0 && acIndex >= 0) {
      applyAutocomplete(acOptions[acIndex]);
      return;
    }

    // Collect current text before cursor split
    const text = el.innerText.trim();

    // Character/dialogue auto-cycle
    let nextType = NEXT_TYPE[type] || 'action';

    // If dialogue line is empty, jump back to action
    if ((type === 'dialogue' || type === 'parenthetical') && text === '') {
      nextType = 'action';
    }

    // Record character names on Enter from character line
    if (type === 'character' && text) {
      characterNames.add(text.toUpperCase());
    }

    const newEl = insertLineAfter(el, nextType, '', true);
    changeLineType(newEl, nextType);
    updateStats();
    updateSidebar();
    markUnsaved();
    return;
  }

  // Backspace: remove empty line OR merge with previous line when at start
  if (e.key === 'Backspace') {
    const idx = lines.findIndex(l => l.el === el);
    const isEmpty = el.innerText === '';

    // Check if cursor is at the very beginning of the line
    const sel = window.getSelection();
    const atStart = sel && sel.rangeCount > 0 && sel.getRangeAt(0).startOffset === 0 &&
      sel.getRangeAt(0).collapsed &&
      (sel.getRangeAt(0).startContainer === el ||
       (sel.getRangeAt(0).startContainer === el.firstChild && sel.getRangeAt(0).startOffset === 0));

    if ((isEmpty || atStart) && idx > 0) {
      e.preventDefault();
      const prev = lines[idx - 1].el;
      if (isEmpty) {
        // Empty line: just remove it and focus previous
        removeLine(el);
        placeCursorAtEnd(prev);
      } else {
        // Non-empty line at cursor start: merge text into previous line
        const currentText = el.innerText;
        const prevText = prev.innerText;
        // Place cursor at the join point in the previous line
        prev.innerText = prevText + currentText;
        // Remove current line
        lines.splice(idx, 1);
        el.remove();
        // Place cursor at the join point
        const range = document.createRange();
        const selObj = window.getSelection();
        const textNode = prev.firstChild || prev;
        const offset = Math.min(prevText.length, textNode.nodeType === Node.TEXT_NODE ? textNode.length : 0);
        try {
          range.setStart(textNode, offset);
          range.collapse(true);
          selObj.removeAllRanges();
          selObj.addRange(range);
        } catch(err) {
          placeCursorAtEnd(prev);
        }
        prev.focus();
      }
      updateStats();
      updateSidebar();
      markUnsaved();
      return;
    }
  }

  // Arrow up/down navigation
  if (e.key === 'ArrowDown') {
    if (acOptions.length > 0) {
      e.preventDefault();
      acIndex = Math.min(acIndex + 1, acOptions.length - 1);
      renderAutocomplete();
      return;
    }
    const idx = lines.findIndex(l => l.el === el);
    if (idx < lines.length - 1) {
      e.preventDefault();
      lines[idx + 1].el.focus();
      placeCursorAtEnd(lines[idx + 1].el);
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    if (acOptions.length > 0) {
      e.preventDefault();
      acIndex = Math.max(acIndex - 1, 0);
      renderAutocomplete();
      return;
    }
    const idx = lines.findIndex(l => l.el === el);
    if (idx > 0) {
      e.preventDefault();
      lines[idx - 1].el.focus();
      placeCursorAtEnd(lines[idx - 1].el);
    }
    return;
  }

  // Escape: close autocomplete
  if (e.key === 'Escape') {
    hideAutocomplete();
    return;
  }
}

function onLineInput(e) {
  const el = e.currentTarget;
  const text = el.innerText;
  const type = el.dataset.type;

  // Auto-detect scene heading start
  if (type === 'action') {
    if (/^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(text)) {
      changeLineType(el, 'scene-heading');
    }
  }

  // Autocomplete
  triggerAutocomplete(el);
  updateStats();
  updateSidebar();
  markUnsaved();
}

function onLineFocus(e) {
  const el = e.currentTarget;
  if (currentLine) currentLine.classList.remove('focused-line');
  currentLine = el;
  el.classList.add('focused-line');
  currentType = el.dataset.type;
  updateElementBar();
  updateCurrentTypeBadge();
}

function onLineBlur(e) {
  const el = e.currentTarget;
  const text = el.innerText.trim();
  if (el.dataset.type === 'character' && text) {
    characterNames.add(text.toUpperCase());
  }
  el.classList.remove('focused-line');
}

function onLinePaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

// ═══════════════════════════════════════════════════════
// ELEMENT TYPE
// ═══════════════════════════════════════════════════════
function changeLineType(el, type) {
  el.dataset.type = type;
  const idx = lines.findIndex(l => l.el === el);
  if (idx >= 0) lines[idx].type = type;
  currentType = type;
  el.setAttribute('aria-label', (ELEMENT_LABELS[type] || type) + ' line. Press Tab to change element type.');
  updateElementBar();
  updateCurrentTypeBadge();
}

function setElementType(type) {
  if (currentLine) {
    changeLineType(currentLine, type);
    currentLine.focus();
  }
  currentType = type;
  updateElementBar();
}

function updateElementBar() {
  document.querySelectorAll('.el-btn').forEach(btn => {
    const active = btn.dataset.type === currentType;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

// ═══════════════════════════════════════════════════════
// AUTOCOMPLETE
// ═══════════════════════════════════════════════════════
function triggerAutocomplete(el) {
  const type = el.dataset.type;
  const text = el.innerText.trim().toUpperCase();
  if (!text) { hideAutocomplete(); return; }

  let options = [];

  if (type === 'scene-heading') {
    const pool = ['INT. ', 'EXT. ', 'INT./EXT. ',
      'INT. OFFICE - DAY', 'INT. HOUSE - NIGHT', 'INT. CAR - MOVING',
      'EXT. STREET - DAY', 'EXT. PARK - NIGHT',
      ...Array.from(sceneHeadings)];
    options = [...new Set(pool)].filter(s => s.toUpperCase().startsWith(text) && s.toUpperCase() !== text);
  }

  if (type === 'character') {
    options = Array.from(characterNames).filter(n => n.startsWith(text) && n !== text);
  }

  if (options.length === 0) { hideAutocomplete(); return; }

  acOptions = options.slice(0, 8);
  acIndex = 0;
  showAutocomplete(el);
}

function showAutocomplete(el) {
  const ac = document.getElementById('autocomplete');
  const rect = el.getBoundingClientRect();
  ac.style.left = (rect.left) + 'px';
  ac.style.top = (rect.bottom + 4) + 'px';
  ac.style.display = 'block';
  renderAutocomplete();
}

function renderAutocomplete() {
  const ac = document.getElementById('autocomplete');
  ac.innerHTML = '<div class="ac-header">Suggestions</div>' +
    acOptions.map((o, i) =>
      `<div class="ac-item${i === acIndex ? ' selected' : ''}" onclick="applyAutocomplete('${o.replace(/'/g,"\\'")}')">
        ${o}
      </div>`).join('');
}

function applyAutocomplete(value) {
  if (!currentLine) return;
  currentLine.innerText = value;
  placeCursorAtEnd(currentLine);
  hideAutocomplete();
  if (currentLine.dataset.type === 'scene-heading') sceneHeadings.add(value);
  updateStats();
  updateSidebar();
}

function hideAutocomplete() {
  document.getElementById('autocomplete').style.display = 'none';
  acOptions = [];
  acIndex = -1;
}

// ═══════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════
function switchSidebarTab(tab, btn) {
  document.querySelectorAll('.stab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
    t.setAttribute('tabindex', '-1');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  btn.setAttribute('tabindex', '0');
  ['scenes','characters','notes'].forEach(t => {
    document.getElementById('tab-' + t).style.display = t === tab ? '' : 'none';
  });
}

function updateSidebar() {
  // Scenes
  const sceneEls = lines.filter(l => l.type === 'scene-heading');
  const scenesDiv = document.getElementById('tab-scenes');
  if (sceneEls.length === 0) {
    scenesDiv.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">No scenes yet.</div>';
  } else {
    scenesDiv.innerHTML = sceneEls.map((s, i) =>
      `<div class="scene-item" onclick="scrollToLine(this)" data-idx="${lines.indexOf(s)}">
        <span class="scene-num">${i + 1}</span>${s.el.innerText || '(empty)'}
      </div>`
    ).join('');
  }

  // Characters
  const charCount = {};
  lines.forEach(l => {
    if (l.type === 'character' && l.el.innerText.trim()) {
      const n = l.el.innerText.trim().toUpperCase();
      charCount[n] = (charCount[n] || 0) + 1;
    }
  });
  const charsDiv = document.getElementById('tab-characters');
  const sorted = Object.entries(charCount).sort((a,b) => b[1]-a[1]);
  if (sorted.length === 0) {
    charsDiv.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">No characters yet.</div>';
  } else {
    charsDiv.innerHTML = sorted.map(([name, count]) =>
      `<div class="char-item"><span>${name}</span><span class="char-count">${count} lines</span></div>`
    ).join('');
  }

  // Update global character set
  characterNames = new Set(Object.keys(charCount));
}

function scrollToLine(el) {
  const idx = parseInt(el.dataset.idx);
  if (lines[idx]) {
    lines[idx].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    lines[idx].el.focus();
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  if (btn) btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
}

// ═══════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════
function updateStats() {
  const allText = lines.map(l => l.el.innerText).join('\n');
  const words = allText.trim().split(/\s+/).filter(Boolean).length;
  const scenes = lines.filter(l => l.type === 'scene-heading').length;
  // Rough page estimate: ~55 lines/page
  const totalLines = lines.length + lines.reduce((a, l) => {
    const t = l.el.innerText;
    return a + (t ? Math.floor(t.length / 65) : 0);
  }, 0);
  const pages = Math.max(1, Math.ceil(totalLines / 55));

  document.getElementById('stat-words').textContent = `Words: ${words}`;
  document.getElementById('stat-scenes').textContent = `Scenes: ${scenes}`;
  document.getElementById('stat-pages').textContent = `Pages: ~${pages}`;
  document.getElementById('stat-chars').textContent = `Characters: ${new Set(lines.filter(l => l.type === 'character').map(l => l.el.innerText.trim().toUpperCase())).size}`;
}

// ═══════════════════════════════════════════════════════
// SAVE / LOAD
// ═══════════════════════════════════════════════════════
function getScriptData() {
  return {
    title: document.getElementById('title-input').value,
    notes: document.getElementById('notes-area').value,
    titlePage: titlePageData,
    lines: lines.map(l => ({ type: l.type, text: l.el.innerText }))
  };
}

function autoSave() {
  try {
    localStorage.setItem('scriptforge_autosave', JSON.stringify(getScriptData()));
    setSaved();
  } catch(e) {}
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem('scriptforge_autosave');
    if (!raw) return;
    const data = JSON.parse(raw);
    document.getElementById('title-input').value = data.title || 'Untitled';
    document.getElementById('notes-area').value = data.notes || '';
    titlePageData = data.titlePage || null;
    const page = document.getElementById('page-1');
    // clear
    page.innerHTML = '<div class="page-number">1.</div>';
    lines = [];
    (data.lines || []).forEach(l => addLine(l.type, l.text, false));
    setSaved();
  } catch(e) {}
}

function markUnsaved() {
  const ind = document.getElementById('save-indicator');
  ind.textContent = '● Unsaved';
  ind.className = 'unsaved';
  // Debounce undo snapshots — push ~400ms after user stops typing
  clearTimeout(undoDebounceTimer);
  undoDebounceTimer = setTimeout(pushUndo, 400);
}

function pushUndo() {
  const snapshot = {
    lines: lines.map(l => ({ type: l.type, text: l.el.innerText })),
    focusIdx: lines.findIndex(l => l.el === currentLine)
  };
  // Don't push duplicate of top
  if (undoStack.length > 0) {
    const top = undoStack[undoStack.length - 1];
    const same = top.lines.length === snapshot.lines.length &&
      top.lines.every((tl, i) => tl.type === snapshot.lines[i].type && tl.text === snapshot.lines[i].text);
    if (same) return;
  }
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack = []; // new action clears redo
}

function applySnapshot(snapshot) {
  const page = document.getElementById('page-1');
  page.innerHTML = '<div class="page-number">1.</div>';
  lines = [];
  snapshot.lines.forEach(l => addLine(l.type, l.text, false));
  const focusEl = lines[snapshot.focusIdx >= 0 ? snapshot.focusIdx : lines.length - 1];
  if (focusEl) { focusEl.el.focus(); placeCursorAtEnd(focusEl.el); }
  updateStats();
  updateSidebar();
}

function undo() {
  if (undoStack.length === 0) return;
  // Push current state to redo before undoing
  redoStack.push({
    lines: lines.map(l => ({ type: l.type, text: l.el.innerText })),
    focusIdx: lines.findIndex(l => l.el === currentLine)
  });
  const snapshot = undoStack.pop();
  applySnapshot(snapshot);
  markUnsaved();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push({
    lines: lines.map(l => ({ type: l.type, text: l.el.innerText })),
    focusIdx: lines.findIndex(l => l.el === currentLine)
  });
  const snapshot = redoStack.pop();
  applySnapshot(snapshot);
  markUnsaved();
}
function setSaved() {
  const ind = document.getElementById('save-indicator');
  ind.textContent = '● Saved';
  ind.className = 'saved';
}

function newScript() {
  if (!confirm('Start a new script? Unsaved changes will be lost.')) return;
  document.getElementById('title-input').value = 'Untitled Screenplay';
  document.getElementById('notes-area').value = '';
  titlePageData = null;
  const page = document.getElementById('page-1');
  page.innerHTML = '<div class="page-number">1.</div>';
  lines = [];
  characterNames = new Set();
  addLine('scene-heading', '', true);
  updateStats();
  updateSidebar();
  setSaved();
}

function saveToFile() {
  const data = getScriptData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (data.title || 'screenplay').replace(/\s+/g,'_') + '.sfx';
  a.click();
  setSaved();
}

function loadFromFile() {
  document.getElementById('file-input').click();
}

function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      if (file.name.endsWith('.sfx')) {
        const data = JSON.parse(ev.target.result);
        document.getElementById('title-input').value = data.title || 'Untitled';
        document.getElementById('notes-area').value = data.notes || '';
        titlePageData = data.titlePage || null;
        const page = document.getElementById('page-1');
        page.innerHTML = '<div class="page-number">1.</div>';
        lines = [];
        (data.lines || []).forEach(l => addLine(l.type, l.text, false));
      } else if (file.name.endsWith('.fdx')) {
        importFDX(ev.target.result);
      } else {
        importFountain(ev.target.result);
      }
      updateStats();
      updateSidebar();
      setSaved();
    } catch(err) {
      alert('Could not load file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ═══════════════════════════════════════════════════════
// FOUNTAIN IMPORT/EXPORT
// ═══════════════════════════════════════════════════════
function importFountain(text) {
  const page = document.getElementById('page-1');
  page.innerHTML = '<div class="page-number">1.</div>';
  lines = [];
  const rawLines = text.split('\n');
  let prevBlank = true;
  rawLines.forEach(raw => {
    let t = raw.trimEnd();
    let type = 'action';
    if (t === '') { prevBlank = true; return; }
    if (/^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(t) && prevBlank) type = 'scene-heading';
    else if (/^[A-Z][A-Z0-9\s\(\)]+$/.test(t) && prevBlank && t.length < 40) type = 'character';
    else if (/^(FADE IN:|FADE OUT:|CUT TO:|DISSOLVE TO:|SMASH CUT TO:)/.test(t)) type = 'transition';
    else if (/^\(.*\)$/.test(t)) type = 'parenthetical';
    else type = 'action';
    addLine(type, t, false);
    prevBlank = false;
  });
  if (lines.length === 0) addLine('action','',true);
}

// ═══════════════════════════════════════════════════════
// FDX IMPORT (Final Draft XML)
// ═══════════════════════════════════════════════════════
function importFDX(xmlText) {
  const parsed = parseFDX(xmlText);
  const page = document.getElementById('page-1');
  page.innerHTML = '<div class="page-number">1.</div>';
  lines = [];
  characterNames = new Set();
  parsed.forEach(l => {
    addLine(l.type, l.text, false);
    if (l.type === 'character') characterNames.add(l.text.toUpperCase());
  });
  if (lines.length === 0) addLine('action', '', true);
}

function parseFDX(xmlText) {
  // FDX is XML — parse it natively in the browser
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  // Check for parse errors
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Invalid FDX file: ' + err.textContent.slice(0, 100));

  // Map Final Draft element types → our types
  const typeMap = {
    'Scene Heading':   'scene-heading',
    'Action':          'action',
    'Character':       'character',
    'Dialogue':        'dialogue',
    'Parenthetical':   'parenthetical',
    'Transition':      'transition',
    'Shot':            'scene-heading',   // treat Shot like a scene heading
    'General':         'action',
    'Centered':        'centered',
    'Cast List':       'action',
    'More':            'action',
    'Cont':            'action',
  };

  const result = [];

  // Each <Paragraph> in FDX holds one screenplay element
  const paragraphs = doc.querySelectorAll('Paragraph');
  paragraphs.forEach(para => {
    const fdxType = para.getAttribute('Type') || 'Action';
    const ourType = typeMap[fdxType] || 'action';

    // Collect all text from <Text> children (FDX can split one line into styled runs)
    let text = '';
    para.querySelectorAll('Text').forEach(textNode => {
      text += textNode.textContent;
    });

    text = text.trim();
    if (!text) return; // skip empty paragraphs

    result.push({ type: ourType, text });
  });

  return result;
}

function exportFountain() {
  let out = '';
  if (titlePageData) {
    out += `Title: ${titlePageData.title}\nCredit: Written by\nAuthor: ${titlePageData.author}\n\n`;
  }
  lines.forEach(l => {
    const t = l.el.innerText;
    if (l.type === 'scene-heading') out += '\n' + t.toUpperCase() + '\n\n';
    else if (l.type === 'character') out += '\n' + t.toUpperCase() + '\n';
    else if (l.type === 'transition') out += '\n' + t.toUpperCase() + '\n\n';
    else out += t + '\n';
  });
  const title = document.getElementById('title-input').value || 'screenplay';
  const blob = new Blob([out], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = title.replace(/\s+/g,'_') + '.fountain';
  a.click();
}

// ═══════════════════════════════════════════════════════
// FDX EXPORT (Final Draft XML)
// ═══════════════════════════════════════════════════════
function exportFDX() {
  const title = document.getElementById('title-input').value || 'Untitled Screenplay';

  // Map our element types to Final Draft Paragraph Type attributes
  const typeMap = {
    'scene-heading': 'Scene Heading',
    'action':        'Action',
    'character':     'Character',
    'dialogue':      'Dialogue',
    'parenthetical': 'Parenthetical',
    'transition':    'Transition',
    'centered':      'General',
  };

  // Build the <Content> paragraphs
  let paragraphs = '';

  // Title page as a centered paragraph if present
  if (titlePageData && titlePageData.title) {
    const esc = fdxEsc(titlePageData.title);
    paragraphs += `\n      <Paragraph Type="General" Alignment="Center"><Text>${esc}</Text></Paragraph>`;
    if (titlePageData.author) {
      paragraphs += `\n      <Paragraph Type="General" Alignment="Center"><Text>Written by ${fdxEsc(titlePageData.author)}</Text></Paragraph>`;
    }
    if (titlePageData.based) {
      paragraphs += `\n      <Paragraph Type="General" Alignment="Center"><Text>${fdxEsc(titlePageData.based)}</Text></Paragraph>`;
    }
    paragraphs += `\n      <Paragraph Type="General"><Text></Text></Paragraph>`;
  }

  lines.forEach(l => {
    const text = l.el.innerText.trim();
    if (!text) return;
    const fdxType = typeMap[l.type] || 'Action';
    const esc = fdxEsc(text);
    paragraphs += `\n      <Paragraph Type="${fdxType}"><Text>${esc}</Text></Paragraph>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="2">
  <Content>${paragraphs}
  </Content>
  <TitlePage>
    <Content>
      <Paragraph Alignment="Center"><Text>${fdxEsc(titlePageData ? titlePageData.title : title)}</Text></Paragraph>
      ${titlePageData && titlePageData.author ? `<Paragraph Alignment="Center"><Text>Written by ${fdxEsc(titlePageData.author)}</Text></Paragraph>` : ''}
      ${titlePageData && titlePageData.contact ? `<Paragraph Alignment="Center"><Text>${fdxEsc(titlePageData.contact)}</Text></Paragraph>` : ''}
    </Content>
  </TitlePage>
  <HeaderAndFooter FooterFirstPage="No" FooterVisible="No" HeaderFirstPage="No" HeaderVisible="Yes" StartingPage="1">
    <Header>
      <Paragraph><Text> </Text></Paragraph>
    </Header>
  </HeaderAndFooter>
</FinalDraft>`;

  const blob = new Blob([xml], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = title.replace(/\s+/g, '_') + '.fdx';
  a.click();
}

function fdxEsc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════
// PDF EXPORT — full script via jsPDF
// ═══════════════════════════════════════════════════════
async function exportPDF() {
  // Dynamically load jsPDF if not already present
  if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { jsPDF } = window.jspdf || window;

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });

  // Page dimensions (letter: 612 x 792 pt)
  const pageW = 612, pageH = 792;
  const marginTop = 72, marginBottom = 72, marginLeft = 108, marginRight = 72;
  const contentW = pageW - marginLeft - marginRight;
  const fontSize = 12;
  const lineH = 14;

  const indent = {
    'scene-heading':  0,
    'action':         0,
    'character':      216,
    'parenthetical':  144,
    'dialogue':       108,
    'transition':     0,
    'centered':       0,
  };
  const rightLimit = {
    'dialogue':       contentW - 72,
    'parenthetical':  contentW - 72,
  };

  let y = marginTop + 24;
  let pageNum = 1;

  function drawPageNum(n) {
    doc.setFont('Courier', 'normal');
    doc.setFontSize(fontSize);
    doc.text(n + '.', pageW - marginRight, marginTop - 12, { align: 'right' });
  }

  function spaceBefore(type) {
    if (type === 'scene-heading') return lineH * 2;
    if (type === 'action') return lineH;
    if (type === 'character') return lineH;
    if (type === 'transition') return lineH;
    return 0;
  }

  drawPageNum(pageNum);

  // Title page
  if (titlePageData && titlePageData.title) {
    doc.setFont('Courier', 'bold');
    doc.setFontSize(fontSize);
    const ty = pageH / 2 - 40;
    doc.text(titlePageData.title.toUpperCase(), pageW / 2, ty, { align: 'center' });
    if (titlePageData.author) {
      doc.setFont('Courier', 'normal');
      doc.text('Written by', pageW / 2, ty + lineH * 2, { align: 'center' });
      doc.text(titlePageData.author, pageW / 2, ty + lineH * 3, { align: 'center' });
    }
    if (titlePageData.based) {
      doc.setFont('Courier', 'normal');
      doc.text(titlePageData.based, pageW / 2, ty + lineH * 5, { align: 'center' });
    }
    if (titlePageData.contact) {
      doc.setFont('Courier', 'normal');
      doc.text(titlePageData.contact, marginLeft, pageH - marginBottom);
    }
    doc.addPage();
    pageNum++;
    y = marginTop + 24;
    drawPageNum(pageNum);
  }

  lines.forEach(l => {
    const type = l.type;
    const rawText = l.el.innerText.trim();
    if (!rawText) return;

    const displayText = (type === 'scene-heading' || type === 'character' || type === 'transition')
      ? rawText.toUpperCase() : rawText;

    if (type === 'scene-heading' || type === 'character') {
      doc.setFont('Courier', 'bold');
    } else {
      doc.setFont('Courier', 'normal');
    }
    doc.setFontSize(fontSize);

    y += spaceBefore(type);

    const elIndent = indent[type] || 0;
    const maxW = (rightLimit[type] || contentW) - elIndent;
    const x = marginLeft + elIndent;

    const textLines = doc.splitTextToSize(displayText, maxW);

    textLines.forEach(tl => {
      if (y + lineH > pageH - marginBottom) {
        doc.addPage();
        pageNum++;
        y = marginTop + 24;
        drawPageNum(pageNum);
        if (type === 'scene-heading' || type === 'character') {
          doc.setFont('Courier', 'bold');
        } else {
          doc.setFont('Courier', 'normal');
        }
        doc.setFontSize(fontSize);
      }

      if (type === 'transition') {
        doc.text(tl, pageW - marginRight, y, { align: 'right' });
      } else if (type === 'centered') {
        doc.text(tl, pageW / 2, y, { align: 'center' });
      } else {
        doc.text(tl, x, y);
      }
      y += lineH;
    });
  });

  const title = document.getElementById('title-input').value || 'screenplay';
  doc.save(title.replace(/\s+/g,'_') + '.pdf');
}

// ═══════════════════════════════════════════════════════
// TITLE PAGE
// ═══════════════════════════════════════════════════════
function openTitlePageModal() {
  if (titlePageData) {
    document.getElementById('tp-title').value = titlePageData.title || '';
    document.getElementById('tp-author').value = titlePageData.author || '';
    document.getElementById('tp-based').value = titlePageData.based || '';
    document.getElementById('tp-contact').value = titlePageData.contact || '';
  } else {
    document.getElementById('tp-title').value = document.getElementById('title-input').value || '';
  }
  document.getElementById('modal-overlay').classList.add('open');
}
function closeTitlePageModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
function insertTitlePage() {
  titlePageData = {
    title: document.getElementById('tp-title').value,
    author: document.getElementById('tp-author').value,
    based: document.getElementById('tp-based').value,
    contact: document.getElementById('tp-contact').value,
  };
  closeTitlePageModal();
  markUnsaved();
  alert('Title page saved! It will appear when you export to PDF or Fountain.');
}

// ═══════════════════════════════════════════════════════
// FIND / REPLACE
// ═══════════════════════════════════════════════════════
function toggleFindBar() {
  document.getElementById('find-bar').classList.toggle('open');
  if (document.getElementById('find-bar').classList.contains('open')) {
    document.getElementById('find-input').focus();
  }
}
function closeFindBar() {
  document.getElementById('find-bar').classList.remove('open');
  clearHighlights();
}

function findAll() {
  clearHighlights();
  const q = document.getElementById('find-input').value;
  if (!q) return [];
  findMatches = [];
  lines.forEach((l, li) => {
    const text = l.el.innerText;
    let idx = 0;
    while (true) {
      const pos = text.toLowerCase().indexOf(q.toLowerCase(), idx);
      if (pos === -1) break;
      findMatches.push({ lineIdx: li, pos, len: q.length });
      idx = pos + 1;
    }
  });
  document.getElementById('find-status').textContent = `${findMatches.length} match(es)`;
  return findMatches;
}

function findNext() {
  findAll();
  if (findMatches.length === 0) return;
  findIdx = (findIdx + 1) % findMatches.length;
  scrollToMatch(findMatches[findIdx]);
}

function findPrev() {
  findAll();
  if (findMatches.length === 0) return;
  findIdx = (findIdx - 1 + findMatches.length) % findMatches.length;
  scrollToMatch(findMatches[findIdx]);
}

function scrollToMatch(match) {
  if (!match) return;
  const el = lines[match.lineIdx].el;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
}

function clearHighlights() {
  findMatches = [];
  findIdx = 0;
}

function replaceOne() {
  const q = document.getElementById('find-input').value;
  const r = document.getElementById('replace-input').value;
  if (!q) return;
  findAll();
  if (findMatches.length === 0) return;
  const match = findMatches[findIdx];
  const el = lines[match.lineIdx].el;
  const text = el.innerText;
  const before = text.slice(0, match.pos);
  const after = text.slice(match.pos + match.len);
  el.innerText = before + r + after;
  markUnsaved();
  findNext();
}

function replaceAll() {
  const q = document.getElementById('find-input').value;
  const r = document.getElementById('replace-input').value;
  if (!q) return;
  lines.forEach(l => {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    if (re.test(l.el.innerText)) {
      l.el.innerText = l.el.innerText.replace(re, r);
    }
  });
  document.getElementById('find-status').textContent = 'All replaced';
  markUnsaved();
  updateStats();
}

// ═══════════════════════════════════════════════════════
// GLOBAL KEY SHORTCUTS
// ═══════════════════════════════════════════════════════
function globalKeys(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (ctrl && e.key === 's') { e.preventDefault(); autoSave(); return; }
  if (ctrl && e.key === 'f') { e.preventDefault(); toggleFindBar(); return; }
  if (ctrl && e.key === 'n') { e.preventDefault(); newScript(); return; }
}

// ═══════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════
function toggleDark() {
  document.body.classList.toggle('light-mode');
}

// ═══════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════
function placeCursorAtEnd(el) {
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ═══════════════════════════════════════════════════════
// ACCESSIBILITY HELPERS
// ═══════════════════════════════════════════════════════

// Announce message to screen readers via aria-live region
function srAnnounce(msg) {
  const el = document.getElementById('sr-live');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 50);
}

// Update the status bar element type badge
function updateCurrentTypeBadge() {
  const badge = document.getElementById('current-type-badge');
  if (badge) badge.textContent = ELEMENT_LABELS[currentType] || currentType;
}

// Adjustable editor font size (persisted in localStorage)
let editorFontSize = 12;
function changeEditorFontSize(delta) {
  editorFontSize = Math.max(10, Math.min(24, editorFontSize + delta));
  document.querySelectorAll('.script-line').forEach(el => {
    el.style.fontSize = editorFontSize + 'pt';
  });
  const label = document.getElementById('font-size-label');
  if (label) label.textContent = editorFontSize + 'pt';
  try { localStorage.setItem('scriptforge_fontsize', editorFontSize); } catch(e) {}
  srAnnounce('Font size changed to ' + editorFontSize + ' points');
}

// Keyboard navigation for sidebar tabs (arrow keys per ARIA tabs pattern)
function handleTabKey(e, btn) {
  const tabs = Array.from(document.querySelectorAll('.stab'));
  const idx = tabs.indexOf(btn);
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    const next = tabs[(idx + 1) % tabs.length];
    next.focus(); next.click();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
    prev.focus(); prev.click();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    btn.click();
  }
}

// Restore font size on load
document.addEventListener('DOMContentLoaded', () => {
  try {
    const saved = localStorage.getItem('scriptforge_fontsize');
    if (saved) { editorFontSize = parseInt(saved) || 12; }
  } catch(e) {}
  const label = document.getElementById('font-size-label');
  if (label) label.textContent = editorFontSize + 'pt';
});

// Patch insertLineAfter / addLine so new lines also get font size applied
const _origAddLine = addLine;
// Override createLineEl to apply current font size to new lines
const _createLineElOrig = createLineEl;

// Wrap scene-item clicks to make keyboard accessible too
function updateSidebarA11y() {
  document.querySelectorAll('.scene-item').forEach(item => {
    if (!item.getAttribute('tabindex')) {
      item.setAttribute('tabindex', '0');
      item.setAttribute('role', 'button');
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
      });
    }
  });
}

// Patch updateSidebar to also run a11y fixup
const _origUpdateSidebar = updateSidebar;
function updateSidebar() {
  _origUpdateSidebar();
  updateSidebarA11y();
}

// Patch openTitlePageModal to trap focus inside dialog
function openTitlePageModal() {
  if (titlePageData) {
    document.getElementById('tp-title').value = titlePageData.title || '';
    document.getElementById('tp-author').value = titlePageData.author || '';
    document.getElementById('tp-based').value = titlePageData.based || '';
    document.getElementById('tp-contact').value = titlePageData.contact || '';
  } else {
    document.getElementById('tp-title').value = document.getElementById('title-input').value || '';
  }
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('tp-title').focus(), 50);
}

// Escape key closes modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('modal-overlay').classList.contains('open')) closeTitlePageModal();
    if (document.getElementById('import-overlay').classList.contains('open')) closeImportModal();
  }
});

const printStyle = document.createElement('style');
printStyle.textContent = `
@media print {
  #toolbar, #element-bar, #sidebar, #statusbar, #autocomplete, #find-bar, #modal-overlay { display: none !important; }
  body { background: white; }
  #main { display: block; }
  #editor-wrapper { overflow: visible; padding: 0; background: white; }
  #page-container { max-width: none; }
  .page { box-shadow: none; margin: 0; padding: 96px 96px 96px 144px; page-break-after: always; }
  .script-line[contenteditable] { outline: none; }
}`;
document.head.appendChild(printStyle);
