// ═══════════════════════════════════════════════════════
// IMPORT ENGINE
// ═══════════════════════════════════════════════════════

// PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

let importedLines = []; // staging area before applying

function openImportModal() {
  document.getElementById('import-overlay').classList.add('open');
  resetImportUI();
}
function closeImportModal() {
  document.getElementById('import-overlay').classList.remove('open');
}
function resetImportUI() {
  importedLines = [];
  document.getElementById('import-progress').classList.remove('visible');
  document.getElementById('import-preview').classList.remove('visible');
  document.getElementById('import-apply-btn').style.display = 'none';
  document.getElementById('import-footer-msg').textContent = '';
  document.getElementById('import-file-input').value = '';
  ['step-extract','step-analyze','step-reformat','step-load'].forEach(id => {
    const el = document.getElementById(id);
    el.className = 'progress-step';
    el.querySelector('.step-icon').textContent = '○';
  });
}

// Drag/drop
function dzDragOver(e) { e.preventDefault(); document.getElementById('drop-zone').classList.add('drag-over'); }
function dzDragLeave(e) { document.getElementById('drop-zone').classList.remove('drag-over'); }
function dzDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processImportFile(file);
}
function handleImportFile(e) {
  const file = e.target.files[0];
  if (file) processImportFile(file);
}

// ── STEP HELPERS ──
function setStep(id, state) {
  const el = document.getElementById(id);
  el.className = 'progress-step ' + state;
  const icons = { done: '✓', active: '<span class="spinner">⟳</span>', error: '✗', '': '○' };
  el.querySelector('.step-icon').innerHTML = icons[state] || '○';
}

// ── MAIN IMPORT PIPELINE ──
async function processImportFile(file) {
  resetImportUI();
  document.getElementById('import-progress').classList.add('visible');
  document.getElementById('import-footer-msg').textContent = 'Processing...';

  try {
    // STEP 1: Extract text
    setStep('step-extract', 'active');
    let rawText = '';
    let structureHints = []; // hints from DOCX styles

    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'fdx') {
      // FDX is structured XML — parse directly, skip analysis/reformat steps
      setStep('step-extract', 'done');
      setStep('step-analyze', 'active');
      const xmlText = await readAsText(file);
      const formatted = parseFDX(xmlText);
      setStep('step-analyze', 'done');
      setStep('step-reformat', 'done');
      setStep('step-load', 'active');
      importedLines = formatted;
      renderImportPreview(formatted);
      setStep('step-load', 'done');
      document.getElementById('import-footer-msg').textContent =
        `✓ Ready — ${formatted.length} elements from Final Draft file`;
      document.getElementById('import-apply-btn').style.display = '';
      return;
    } else if (ext === 'pdf') {
      rawText = await extractPDF(file);
    } else if (ext === 'docx' || ext === 'doc') {
      const result = await extractDOCX(file);
      rawText = result.text;
      structureHints = result.hints;
    } else {
      // .txt / .fountain - read as text
      rawText = await readAsText(file);
    }

    if (!rawText.trim()) throw new Error('No text could be extracted from the file.');
    setStep('step-extract', 'done');

    // STEP 2: Analyze structure
    setStep('step-analyze', 'active');
    const analysis = analyzeRawText(rawText, structureHints);
    setStep('step-analyze', 'done');

    // STEP 3: Reformat (free, fully local)
    setStep('step-reformat', 'active');
    let formatted = smartReformat(analysis);
    setStep('step-reformat', 'done');

    // STEP 4: Stage and preview
    setStep('step-load', 'active');
    importedLines = formatted;
    renderImportPreview(formatted);
    setStep('step-load', 'done');

    document.getElementById('import-footer-msg').textContent =
      `✓ Ready — ${formatted.length} elements detected`;
    document.getElementById('import-apply-btn').style.display = '';

  } catch (err) {
    ['step-extract','step-analyze','step-reformat','step-load'].forEach(id => {
      if (document.getElementById(id).classList.contains('active'))
        setStep(id, 'error');
    });
    document.getElementById('import-footer-msg').textContent = '⚠ ' + err.message;
    console.error('Import error:', err);
  }
}

// ── TEXT EXTRACTION ──
function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('Could not read file.'));
    r.readAsText(file);
  });
}

async function extractPDF(file) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js failed to load. Please check your internet connection.');
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  let fullText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // Reconstruct lines using y-position grouping
    const items = tc.items;
    const yGroups = {};
    items.forEach(item => {
      if (!item.str.trim()) return;
      const y = Math.round(item.transform[5]);
      if (!yGroups[y]) yGroups[y] = { x: item.transform[4], parts: [] };
      yGroups[y].parts.push({ x: item.transform[4], text: item.str });
    });
    const ys = Object.keys(yGroups).map(Number).sort((a, b) => b - a);
    ys.forEach(y => {
      const g = yGroups[y];
      const sorted = g.parts.sort((a, b) => a.x - b.x);
      const lineText = sorted.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
      if (lineText) fullText += lineText + '\n';
    });
    fullText += '\n'; // page break
  }
  return fullText;
}

async function extractDOCX(file) {
  if (typeof mammoth === 'undefined') throw new Error('mammoth.js failed to load. Please check your internet connection.');
  const ab = await file.arrayBuffer();
  // Extract with style names preserved
  const result = await mammoth.extractRawText({ arrayBuffer: ab });
  // Also get HTML for style hints
  let hints = [];
  try {
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer: ab });
    hints = parseDocxHints(htmlResult.value);
  } catch(e) {}
  return { text: result.value, hints };
}

function parseDocxHints(html) {
  // Extract structural hints from mammoth HTML output
  const div = document.createElement('div');
  div.innerHTML = html;
  const hints = [];
  div.querySelectorAll('p, h1, h2, h3, h4').forEach(el => {
    const text = el.innerText.trim();
    if (!text) return;
    let hint = 'action';
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2') hint = 'scene-heading';
    else if (tag === 'h3') hint = 'character';
    else if (tag === 'h4') hint = 'parenthetical';
    else if (el.style.textAlign === 'center') hint = 'centered';
    hints.push({ text, hint });
  });
  return hints;
}

// ── STRUCTURE ANALYSIS ──
function analyzeRawText(raw, structureHints) {
  const rawLines = raw.split('\n').map(l => l.trimEnd());

  // Measure indentation distribution
  const indentCounts = {};
  rawLines.forEach(l => {
    if (!l.trim()) return;
    const indent = l.length - l.trimStart().length;
    indentCounts[indent] = (indentCounts[indent] || 0) + 1;
  });

  // Detect common indent levels
  const indentLevels = Object.entries(indentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => parseInt(k));

  // Assign roles to indent levels heuristically
  const baseIndent = indentLevels[0] || 0;

  // Build annotated lines
  const annotated = [];
  let prevBlank = true;

  rawLines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed) { prevBlank = true; return; }
    const indent = raw.length - raw.trimStart().length;

    // Check for hint from DOCX
    const hint = structureHints.find(h => h.text === trimmed);

    let type = guessType(trimmed, indent, baseIndent, prevBlank, hint?.hint);
    annotated.push({ text: trimmed, type, indent, raw });
    prevBlank = false;
  });

  return { lines: annotated, baseIndent, indentLevels };
}

function guessType(text, indent, baseIndent, prevBlank, hint) {
  if (hint && hint !== 'action') return hint;

  // Scene headings
  if (/^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(text)) return 'scene-heading';
  if (/^(INT |EXT )/i.test(text) && text.length < 80) return 'scene-heading';

  // Transitions
  if (/^(FADE IN:|FADE OUT:|FADE TO:|CUT TO:|DISSOLVE TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|TIME CUT:|WIPE TO:)/.test(text)) return 'transition';
  if (/^(FADE IN|FADE OUT|FADE TO BLACK)\.*:?$/.test(text)) return 'transition';

  // Parenthetical
  if (/^\(.*\)$/.test(text)) return 'parenthetical';

  // All-caps short lines = likely character
  if (/^[A-Z][A-Z0-9\s\.\-']+$/.test(text) && text.length < 45 && prevBlank) {
    // Exclude common false positives
    if (!/^(INT|EXT|THE|AND|BUT|CUT|FADE|DISSOLVE|END|ACT|SCENE|PAGE)/.test(text)) {
      return 'character';
    }
  }

  // High indent relative to base = probably dialogue or character
  if (indent > baseIndent + 20) {
    if (/^[A-Z\s]+$/.test(text) && text.length < 40) return 'character';
    return 'dialogue';
  }
  if (indent > baseIndent + 10) return 'dialogue';

  return 'action';
}

// ── SMART FREE REFORMAT ENGINE ──
// Multi-pass, geometry-aware, context-sensitive. No API needed.
function smartReformat(analysis) {
  const raw = analysis.lines;
  if (!raw.length) return [];

  // ── PASS 1: Geometry calibration ──
  // Find the dominant left-margin (action text indent)
  // and measure how far character/dialogue are offset from it.
  const indentCounts = {};
  raw.forEach(l => { indentCounts[l.indent] = (indentCounts[l.indent] || 0) + 1; });
  const sortedIndents = Object.entries(indentCounts)
    .sort((a,b) => b[1]-a[1])
    .map(([k]) => parseInt(k));

  const baseIndent   = sortedIndents[0] || 0;       // most common = action/desc margin
  const secondIndent = sortedIndents[1] || baseIndent + 8;
  const thirdIndent  = sortedIndents[2] || baseIndent + 20;

  // Character names typically sit at a deeper indent than dialogue
  // Dialogue is typically mid-indent; action is at base.
  // We'll score each line using multiple signals.

  // ── PASS 2: Line classification ──
  const classified = raw.map((line, i) => {
    const t = line.text;
    const ind = line.indent;
    const upper = t === t.toUpperCase();
    const short = t.length < 42;
    const veryShort = t.length < 22;

    // Hard rules (very high confidence)
    if (/^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)\s/i.test(t)) return tag(line, 'scene-heading');
    if (/^(INT |EXT )/i.test(t) && t.includes(' - ')) return tag(line, 'scene-heading');
    if (/^(FADE\s*IN\s*:|FADE\s*OUT\s*:|FADE\s*TO\s*:|CUT\s*TO\s*:|DISSOLVE\s*TO\s*:|SMASH\s*CUT|MATCH\s*CUT|JUMP\s*CUT|TIME\s*CUT|WIPE\s*TO\s*:|IRIS\s*(IN|OUT))/.test(t)) return tag(line, 'transition');
    if (/^\(.*\)$/.test(t) && t.length < 60) return tag(line, 'parenthetical');

    // All-caps short line = strong character candidate
    if (upper && short && /^[A-Z][A-Z0-9\s'\.\-\(\)]+$/.test(t)) {
      // Exclude false positives
      if (!/^(THE|AND|BUT|CUT|ACT|END|PAGE|CONTINUED|CONT|MORE|OVER|BACK|TITLE|MONTAGE|SERIES|LATER|CONTINUOUS|INTERCUT|SMASH|MATCH|WIPE|IRIS|ROLL|SUPER|INSERT|ANGLE|VIEW|CLOSE|WIDE|POV|ESTABLISHING|PULL|PUSH|RACK|DOLLY|PAN|TILT|ZOOM|FADE|DISSOLVE|FLASH|FREEZE|SLOW|FAST|SPLIT|DUAL)/.test(t)) {
        return tag(line, 'character');
      }
    }

    // Scene heading without INT/EXT if all-caps + " - DAY/NIGHT/MORNING/EVENING/DUSK/DAWN/LATER/CONTINUOUS"
    if (upper && /\s[-–]\s*(DAY|NIGHT|MORNING|EVENING|DUSK|DAWN|LATER|CONTINUOUS|MOMENTS LATER|SAME TIME|INTERCUT)/.test(t)) {
      return tag(line, 'scene-heading');
    }

    // Geometry-based: deeply indented relative to base
    if (ind > baseIndent + 18) {
      if (upper && short) return tag(line, 'character');
      return tag(line, 'dialogue');
    }
    if (ind > baseIndent + 8) {
      return tag(line, 'dialogue');
    }

    // DOCX hint fallback
    if (line.hint && line.hint !== 'action') return tag(line, line.hint);

    return tag(line, 'action');
  });

  // ── PASS 3: Context repair ──
  // Use neighboring lines to fix classification errors.
  const fixed = classified.map((cur, i) => {
    const prev = classified[i - 1];
    const next = classified[i + 1];
    const prevType = prev?.type;
    const nextType = next?.type;

    // If prev was CHARACTER and current is ACTION → likely DIALOGUE
    if (prevType === 'character' && cur.type === 'action') {
      return { ...cur, type: 'dialogue' };
    }

    // If prev was CHARACTER and current is CHARACTER → prev might be wrong; keep but note
    // If current is dialogue and next is character → that's a normal dialogue/char alternation, keep.

    // If current looks like a character (all-caps short) but prev was also dialogue → DIALOGUE continuation or new character
    if (cur.type === 'character' && prevType === 'dialogue') {
      // If it's very short and all-caps it's likely a new character cue
      if (cur.text.length < 30 && /^[A-Z\s]+$/.test(cur.text)) return cur; // keep as character
      return { ...cur, type: 'dialogue' }; // otherwise treat as continued dialogue
    }

    // Parenthetical must be inside a dialogue block
    if (cur.type === 'parenthetical') {
      if (prevType !== 'dialogue' && prevType !== 'character') {
        // If surrounded by dialogue context keep it, else action
        if (nextType === 'dialogue' || prevType === 'character') return cur;
        return { ...cur, type: 'action' };
      }
    }

    // Transition must be standalone — if surrounded by regular action, keep; correct obvious mis-tags
    if (cur.type === 'action' && /^(OVER BLACK|TO BLACK|THE END|TITLE CARD|SUPER:|SMASH TO BLACK)/.test(cur.text)) {
      return { ...cur, type: 'transition' };
    }

    // "CONTINUED:" style lines
    if (/^(CONTINUED:|CONT'D:|MORE)$/.test(cur.text)) {
      return { ...cur, type: 'transition' };
    }

    return cur;
  });

  // ── PASS 4: Merge broken action paragraphs ──
  // PDF extraction often splits single action paragraphs into many short lines.
  // Re-join lines of the same type that are adjacent.
  const merged = [];
  let i = 0;
  while (i < fixed.length) {
    const cur = fixed[i];
    if (cur.type === 'action') {
      let combined = cur.text;
      let j = i + 1;
      while (j < fixed.length &&
             fixed[j].type === 'action' &&
             !looksLikeNewParagraph(combined, fixed[j].text)) {
        combined += ' ' + fixed[j].text;
        j++;
      }
      merged.push({ text: combined.replace(/\s+/g,' ').trim(), type: 'action' });
      i = j;
    } else {
      merged.push({ text: cur.text, type: cur.type });
      i++;
    }
  }

  // ── PASS 5: Clean up text ──
  return merged
    .filter(l => l.text.trim().length > 0)
    .map(l => ({
      type: l.type,
      text: cleanText(l.text, l.type)
    }));
}

function tag(line, type) {
  return { ...line, type };
}

function looksLikeNewParagraph(prev, next) {
  // Heuristic: if next line starts with a capital and prev ends with sentence-ending punctuation
  if (/[.!?]$/.test(prev.trim()) && /^[A-Z]/.test(next.trim())) return true;
  if (next.length > 5 && next === next.toUpperCase()) return true; // all-caps = new element
  return false;
}

function cleanText(text, type) {
  let t = text.trim();
  // Remove page numbers like "42." or "42" at start of line
  t = t.replace(/^\d+\.\s*/, '');
  // Remove "(CONTINUED)" artifacts
  t = t.replace(/\s*\(CONTINUED\)\s*$/i, '').trim();
  // For scene headings, ensure uppercase
  if (type === 'scene-heading') t = t.toUpperCase();
  // For character, ensure uppercase
  if (type === 'character') t = t.toUpperCase();
  // For transitions, uppercase
  if (type === 'transition') t = t.toUpperCase();
  return t;
}

// ── PREVIEW RENDERER ──
function renderImportPreview(formatted) {
  const preview = document.getElementById('import-preview');
  const box = document.getElementById('preview-box');
  const statsDiv = document.getElementById('import-stats');

  const display = formatted.slice(0, 30);
  const typeClass = {
    'scene-heading': 'preview-scene',
    'character': 'preview-char',
    'dialogue': 'preview-dial',
    'parenthetical': 'preview-paren',
    'transition': 'preview-trans',
    'centered': '',
    'action': ''
  };

  box.innerHTML = display.map(l =>
    `<div class="${typeClass[l.type] || ''}">${escHtml(l.text)}</div>`
  ).join('');

  if (formatted.length > 30) {
    box.innerHTML += `<div style="color:var(--text-dim);margin-top:6px;font-style:italic">… and ${formatted.length - 30} more elements</div>`;
  }

  // Stats
  const counts = {};
  formatted.forEach(l => { counts[l.type] = (counts[l.type] || 0) + 1; });
  const scenes = counts['scene-heading'] || 0;
  const chars = new Set(formatted.filter(l => l.type === 'character').map(l => l.text.toUpperCase())).size;
  const dialLines = counts['dialogue'] || 0;
  statsDiv.innerHTML = `
    <div class="istat">Elements: <span>${formatted.length}</span></div>
    <div class="istat">Scenes: <span>${scenes}</span></div>
    <div class="istat">Characters: <span>${chars}</span></div>
    <div class="istat">Dialogue lines: <span>${dialLines}</span></div>
  `;

  preview.classList.add('visible');
}

function escHtml(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── APPLY TO EDITOR ──
function applyImport() {
  if (!importedLines.length) return;

  const page = document.getElementById('page-1');
  page.innerHTML = '<div class="page-number">1.</div>';
  lines = [];
  characterNames = new Set();

  importedLines.forEach(l => {
    addLine(l.type, l.text, false);
    if (l.type === 'character') characterNames.add(l.text.toUpperCase());
  });

  if (lines.length === 0) addLine('action', '', true);
  else lines[0].el.focus();

  updateStats();
  updateSidebar();
  markUnsaved();
  closeImportModal();
}
