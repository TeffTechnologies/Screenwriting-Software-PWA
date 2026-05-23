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

  // Backspace on empty line: remove it
  if (e.key === 'Backspace' && el.innerText === '') {
    e.preventDefault();
    const idx = lines.findIndex(l => l.el === el);
    if (idx > 0) {
      const prev = lines[idx - 1].el;
      removeLine(el);
      placeCursorAtEnd(prev);
    }
    updateStats();
    updateSidebar();
    markUnsaved();
    return;
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
  updateElementBar();
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
    btn.classList.toggle('active', btn.dataset.type === currentType);
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
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
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
  document.getElementById('sidebar').classList.toggle('collapsed');
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
// PDF EXPORT
// ═══════════════════════════════════════════════════════
function exportPDF() {
  window.print();
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

// Print styles
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
