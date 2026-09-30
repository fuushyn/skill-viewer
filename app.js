/* Skill Viewer (public app) — URL/folder/paste loading, multi-skill overview,
 * static analysis, optional BYOK LLM review via OpenRouter. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- state
  const $ = (id) => document.getElementById(id);
  const state = {
    report: null, raw: '', fileName: '', charts: {}, filter: 'all',
    multi: null,        // [{name, raw, report}] when a folder/repo was loaded
    multiSource: ''
  };

  const ROLE_COLORS = {
    frontmatter: '#64748b', intro: '#818cf8', process: '#22d3ee', guardrails: '#fb7185',
    output: '#34d399', examples: '#fbbf24', reference: '#a78bfa', scope: '#f472b6',
    rules: '#60a5fa', context: '#94a3b8', general: '#475569'
  };
  const ROLE_ORDER = ['frontmatter', 'intro', 'context', 'process', 'rules', 'guardrails', 'output', 'examples', 'scope', 'reference', 'general'];

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  const HL_RE = /(\b(?:MUST|ALWAYS|NEVER|IMPORTANT|CRITICAL|REQUIRED|MANDATORY|EXACTLY|WARNING)\b)|(\b(?:don['’]t|do not|never|avoid|skip|omit|remove|delete|drop|forbid\w*|instead of|rather than|no more|no need)\b)|(\b(?:must|always|mandatory|required|ensure)\b)/g;
  function highlight(text) {
    let out = '', last = 0, m;
    const s = esc(text);
    HL_RE.lastIndex = 0;
    while ((m = HL_RE.exec(s))) {
      out += s.slice(last, m.index);
      if (m[1]) out += '<mark class="caps">' + m[0] + '</mark>';
      else if (m[2]) out += '<mark class="neg">' + m[0] + '</mark>';
      else out += '<mark class="must">' + m[0] + '</mark>';
      last = m.index + m[0].length;
    }
    return out + s.slice(last);
  }

  // ---------------------------------------------------------------- url resolution
  // Accepts: raw.githubusercontent links, github blob/tree/repo links,
  // skills.sh skill pages, any .md URL (CORS permitting).
  async function fetchSkillsFromUrl(input) {
    let url;
    try { url = new URL(input.trim()); } catch (e) { return { error: 'That does not look like a URL.' }; }
    const u = url.hostname.replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    // skills.sh/{owner}/{repo}/{skill} → GitHub repo
    if ((u === 'skills.sh') && parts.length >= 2) {
      const [owner, repo, skillName] = parts;
      return loadFromGithub(owner, repo, undefined, skillName);
    }
    if (u === 'raw.githubusercontent.com' && parts.length >= 4) {
      const [, owner, repo, ...rest] = parts;          // [refs, heads, branch] or branch directly
      let branch, path;
      if (rest[0] === 'refs' && rest[1] === 'heads') { branch = rest[2]; path = rest.slice(3); }
      else { branch = rest[0]; path = rest.slice(1); }
      if (!path.length) return { error: 'Link to a file, not a directory.' };
      const raw = await fetchText(url.href);
      return { skills: [{ name: nameFromFile(path.join('/')), raw }] };
    }
    if (u === 'github.com' || u === 'gist.github.com') {
      if (parts[2] === 'blob' || parts[2] === 'raw') {
        const [owner, repo, , branch, ...path] = parts;
        const raw = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path.map(encodeURIComponent).join('/')}`);
        return { skills: [{ name: nameFromFile(path.join('/')), raw }] };
      }
      if (parts[2] === 'tree') {
        const [owner, repo, , branch, ...sub] = parts;
        return loadFromGithub(owner, repo, branch, undefined, sub.join('/'));
      }
      if (parts.length === 2) return loadFromGithub(parts[0], parts[1]);
      return { error: 'Expected github.com/{owner}/{repo}, …/blob/… or …/tree/…' };
    }
    if (parts.length && url.pathname.endsWith('.md')) {
      const raw = await fetchText(url.href);
      return { skills: [{ name: nameFromFile(url.pathname), raw }] };
    }
    return { error: 'Link a skills.sh skill page, a GitHub repo/blob/tree, or a raw .md file.' };
  }

  function nameFromFile(path) {
    const segs = String(path).split('/');
    const file = segs.pop();
    if (file && file.replace(/\.md$/i, '').toUpperCase() === 'SKILL') return segs.pop() || 'skill';
    return file ? file.replace(/\.md$/i, '') : 'skill';
  }

  async function fetchText(u) {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${trunc(u, 70)}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty file');
    return text;
  }

  // GitHub repo (optionally subtree + single skill name) via the trees API.
  async function loadFromGithub(owner, repo, branch, skillName, sub) {
    const br = branch || await defaultBranch(owner, repo);
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(br)}?recursive=1`;
    const res = await fetch(treeUrl);
    if (!res.ok) throw new Error(`GitHub API ${res.status} — ${res.ok ? '' : (res.status === 403 ? 'rate limit? try again in a minute' : 'repo not found')}`);
    const data = await res.json();
    let paths = (data.tree || []).filter(t => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path)).map(t => t.path);
    if (sub) paths = paths.filter(p => p === sub + '/SKILL.md' || p.startsWith(sub + '/'));
    if (skillName) {
      const exact = paths.filter(p => p.split('/').slice(-2, -1)[0] === skillName);
      if (exact.length) paths = exact;
    }
    if (!paths.length) return { error: `No SKILL.md found in ${owner}/${repo}${sub ? '/' + sub : ''}${skillName ? ' matching "' + skillName + '"' : ''}.` };
    const cap = 60;
    const slice = paths.slice(0, cap);
    const skills = await Promise.all(slice.map(async p => {
      try {
        const raw = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${br}/${p.split('/').map(encodeURIComponent).join('/')}`);
        return { name: nameFromFile(p), raw };
      } catch (e) { return null; }
    }));
    const ok = skills.filter(Boolean);
    if (!ok.length) return { error: 'Could not fetch any SKILL.md from that repo.' };
    return { skills: ok, truncated: paths.length > cap ? paths.length : 0 };
  }

  async function defaultBranch(owner, repo) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (!res.ok) throw new Error(`GitHub API ${res.status} — repo not found or rate limited`);
    const d = await res.json();
    return d.default_branch || 'main';
  }

  // ---------------------------------------------------------------- loading
  function analyzeOne(raw, name) {
    const report = SkillAnalyzer.analyze(raw);
    report.__raw = raw;
    return { name, raw, report };
  }

  function loadSkills(list, sourceLabel, truncated) {
    const analyzed = [];
    for (const s of list) {
      try { analyzed.push(analyzeOne(s.raw, s.name)); } catch (e) { console.warn('analyze failed', s.name, e); }
    }
    if (!analyzed.length) { toast('No analyzable SKILL.md found', true); return; }
    state.multi = analyzed;
    state.multiSource = sourceLabel;
    if (analyzed.length === 1) { openSkill(0, analyzed.length); return; }
    renderMulti(truncated);
  }

  function showEmpty() {
    $('emptyState').hidden = false;
    $('appState').hidden = true;
    $('multiState').hidden = true;
    ['btnOpen', 'btnPaste', 'btnReset'].forEach(id => $(id).hidden = true);
    $('btnBack').hidden = true;
    state.report = null; state.multi = null;
    Object.values(state.charts).forEach(c => c.dispose());
    state.charts = {};
  }

  function renderMulti(truncated) {
    showMulti();
    const ranked = state.multi.slice().sort((a, b) => a.report.health.score - b.report.health.score);
    $('multiTitle').textContent = `${state.multi.length} skills`;
    $('multiSub').textContent = state.multiSource + ' · worst first · click a skill for the full report' + (truncated ? ` · showing first ${state.multi.length} of ${truncated}` : '');
    $('multiTable').innerHTML =
      `<div class="mrow mhead"><span>skill</span><span>health</span><span>unpaired ✗</span><span>conflicts</span><span>buried</span><span>lines</span><span>tokens</span><span>desc</span></div>` +
      ranked.map((s, i) => {
        const h = s.report.health.score;
        const cls = h >= 80 ? 'good' : h >= 60 ? 'warn' : 'bad';
        return `<div class="mrow" data-idx="${state.multi.indexOf(s)}">
          <span class="mname">${esc(s.name)}</span>
          <span><span class="pill ${cls}">${h} <em>${s.report.health.grade}</em></span></span>
          <span>${s.report.stats.unpairedCount || '<i class="ok">0</i>'}</span>
          <span>${s.report.stats.conflictCount || '<i class="ok">0</i>'}</span>
          <span>${s.report.buried.length}</span>
          <span>${s.report.stats.bodyLines}</span>
          <span>≈${s.report.stats.estTokens}</span>
          <span>${s.report.description.overall}</span>
        </div>`;
      }).join('');
    $('multiTable').querySelectorAll('.mrow[data-idx]').forEach(row => {
      row.onclick = () => openSkill(parseInt(row.dataset.idx, 10), state.multi.length);
    });
  }

  function showMulti() {
    $('emptyState').hidden = true;
    $('appState').hidden = true;
    $('multiState').hidden = false;
    ['btnOpen', 'btnPaste', 'btnReset'].forEach(id => $(id).hidden = false);
    $('btnBack').hidden = true;
  }

  function openSkill(idx, total) {
    const s = state.multi[idx];
    loadSkill(s.raw, s.name + '.md', { keepMulti: true });
    $('btnBack').hidden = false;
    $('btnBack').onclick = (e) => { e.preventDefault(); renderMulti(); };
    if (total > 1) $('srcFileLabel').textContent = `${s.name} · ${idx + 1}/${total}`;
  }

  function loadSkill(text, name, opts) {
    opts = opts || {};
    let report;
    try { report = SkillAnalyzer.analyze(text); }
    catch (e) { toast('Analysis failed: ' + e.message, true); return; }
    report.__raw = text;
    state.raw = text;
    state.report = report;
    state.fileName = name || 'pasted';
    state.filter = 'all';
    if (!opts.keepMulti) state.multi = null;

    $('emptyState').hidden = true;
    $('multiState').hidden = true;
    $('appState').hidden = false;
    ['btnOpen', 'btnPaste', 'btnReset'].forEach(id => $(id).hidden = false);
    $('btnBack').hidden = !(state.multi && state.multi.length > 1);
    if ($('btnBack').hidden !== false) $('btnBack').hidden = true;
    if (state.multi && state.multi.length > 1) {
      $('btnBack').onclick = (e) => { e.preventDefault(); renderMulti(); };
    }
    $('srcFileLabel').textContent = state.fileName;

    $('llmJson').value = '';
    $('llmResults').hidden = true;
    $('llmResults').innerHTML = '';
    $('llmStatus').hidden = true;

    renderAll();
    if (!opts.silent) toast(`Analyzed ${report.stats.totalLines} lines · ${report.sentences.length} instructions`);
  }

  // ---------------------------------------------------------------- render orchestration
  function renderAll() {
    renderSummary(); renderMetrics(); renderSource(); renderAttention();
    renderLedger(); renderConflicts(); renderRibbon(); renderRadar(); renderBudgets(); renderIdeas();
  }

  function renderSummary() {
    const r = state.report, h = r.health;
    $('healthScore').textContent = h.score;
    $('healthGrade').textContent = h.grade;
    const ring = $('healthRing');
    ring.style.setProperty('--pct', h.score);
    const col = h.score >= 80 ? 'var(--emerald)' : h.score >= 60 ? 'var(--amber)' : 'var(--rose)';
    ring.style.setProperty('--ring', col);
    $('skillName').textContent = r.meta.name || r.frontmatter.data.name || '(unnamed skill)';
    $('healthSub').textContent = summarizeHealth();
    $('deductionList').innerHTML = h.deductions.length
      ? h.deductions.map(d => `<li>−${d.points} · ${esc(d.reason)}</li>`).join('')
      : '<li>nothing deducted — clean run</li>';
  }

  function summarizeHealth() {
    const r = state.report, s = r.stats;
    const bits = [];
    bits.push(`${s.positiveCount} positive · ${s.negativeCount} negative · ${s.mustCount} must`);
    if (s.unpairedCount) bits.push(`${s.unpairedCount} unpaired`);
    if (s.conflictCount) bits.push(`${s.conflictCount} conflict${s.conflictCount > 1 ? 's' : ''}`);
    bits.push(`${r.buried.length} buried`);
    return bits.join(' · ');
  }

  function renderMetrics() {
    const r = state.report, s = r.stats;
    const cards = [
      { num: s.totalLines, lbl: 'lines', cls: 'info', act: () => jumpToLine(1) },
      { num: '≈' + s.estTokens, lbl: 'tokens (body est.)', cls: s.estTokens > 5000 ? 'warn' : 'gold', act: () => scrollToCard('budgets') },
      { num: s.positiveCount, lbl: 'positive prompts', cls: 'good', act: () => setFilter('positive') },
      { num: s.negativeCount, lbl: 'negative prompts', cls: s.unpairedCount ? 'warn' : 'info', act: () => setFilter('negative') },
      { num: s.unpairedCount, lbl: 'unpaired ✗', cls: s.unpairedCount ? 'warn' : 'good', act: () => setFilter('unpaired') },
      { num: s.conflictCount, lbl: 'conflicts', cls: s.conflictCount ? 'warn' : 'good', act: () => scrollToCard('conflictCard') }
    ];
    const grid = $('metricGrid');
    grid.innerHTML = '';
    cards.forEach(c => {
      const d = document.createElement('div');
      d.className = 'metric ' + c.cls;
      d.innerHTML = `<div class="num">${c.num}</div><div class="lbl">${c.lbl}</div>`;
      d.onclick = c.act;
      grid.appendChild(d);
    });
  }

  // ---------------------------------------------------------------- source inspector
  function renderSource() {
    const r = state.report;
    const lines = state.raw.split(/\r?\n/);
    const frag = document.createDocumentFragment();
    const sentById = new Map(r.sentences.map(s => [s.id, s]));
    lines.forEach((text, i) => {
      const n = i + 1;
      const lm = r.lineMeta[i] || { kinds: [], sentenceIds: [] };
      const div = document.createElement('div');
      div.className = 'sline' + (lm.inCode ? ' code' : '')
        + (lm.kinds.includes('heading') ? ' heading' : '')
        + (lm.kinds.includes('table') ? ' table' : '')
        + (lm.kinds.includes('quote') ? ' quote' : '');
      div.dataset.line = n;
      const att = r.attention.scores[i] != null ? r.attention.scores[i] : 0;
      const markers = [];
      const seen = new Set();
      for (const sid of lm.sentenceIds) {
        const s = sentById.get(sid);
        if (!s || s.type === 'neutral' || seen.has(s.type)) continue;
        seen.add(s.type);
        const unpaired = s.type === 'negative' && s.pairedWith == null;
        markers.push(unpaired ? '<span class="mk u" title="unpaired negative"></span>'
          : s.type === 'negative' ? '<span class="mk n" title="negative prompt"></span>'
          : s.type === 'must' ? '<span class="mk m" title="hard MUST"></span>'
          : '<span class="mk p" title="positive prompt"></span>');
      }
      div.innerHTML =
        `<span class="ln"><span class="heat" style="opacity:${(att * 0.9).toFixed(2)}"></span>${n}</span>` +
        `<span class="markers">${markers.slice(0, 4).join('')}</span>` +
        `<span class="lt">${highlight(text) || '&nbsp;'}</span>`;
      div.onclick = () => inspectLine(n);
      frag.appendChild(div);
    });
    const wrap = $('sourceLines');
    wrap.innerHTML = '';
    wrap.appendChild(frag);
    $('lineInspector').hidden = true;
  }

  function inspectLine(n) {
    const r = state.report;
    const lm = r.lineMeta[n - 1];
    const box = $('lineInspector');
    const sents = (lm ? lm.sentenceIds : []).map(id => r.sentences.find(s => s.id === id)).filter(Boolean);
    const sec = r.sections.find(s => n >= s.startLine && n <= s.endLine);
    let html = `<b>Line ${n}</b>${sec ? ` · <span class="muted">${esc(sec.title || sec.role)}</span>` : ''}`;
    if (lm && lm.inCode) html += ` · <span class="t-neu">code block</span>`;
    if (!sents.length && !(lm && lm.inCode)) html += '<div class="muted">no extracted instructions on this line</div>';
    sents.forEach(s => {
      const pair = s.type === 'negative'
        ? (s.pairedWith == null ? '<span class="pair-bad">no positive counterpart</span>'
          : `<span class="pair-ok">paired${s.pairHow ? ' (' + s.pairHow + ')' : ''}</span>`)
        : '';
      html += `<div><span class="type-badge ${s.type}">${s.type}</span> ${esc(trunc(s.text, 110))} ${pair}</div>`;
    });
    box.innerHTML = html;
    box.hidden = false;
  }

  function jumpToLine(n) {
    const el = document.querySelector(`.sline[data-line="${n}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    inspectLine(n);
  }

  // ---------------------------------------------------------------- charts
  function chartTooltip() {
    return {
      backgroundColor: 'rgba(10,16,28,0.96)', borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e6edf7', fontSize: 12 },
      extraCssText: 'backdrop-filter:blur(8px);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:340px;'
    };
  }

  function renderAttention() {
    const r = state.report;
    const el = $('attentionChart');
    if (state.charts.att) state.charts.att.dispose();
    const chart = echarts.init(el);
    state.charts.att = chart;
    const lines = state.raw.split(/\r?\n/);
    const N = lines.length;
    const curve = r.attention.scores.map((v, i) => [i + 1, +v.toFixed(3)]);
    const dz = r.attention.deadZone;
    const mkSeries = (name, arr, color, size, extra) => ({
      name, type: 'scatter', data: arr, symbolSize: size, z: 4,
      itemStyle: Object.assign({ color }, extra || {}),
      emphasis: { scale: 1.4 }
    });
    const negatives = [], musts = [], unpaired = [];
    const unpairedIds = new Set(r.unpairedNegatives.map(u => u.id));
    for (const s of r.sentences) {
      if (s.type === 'negative') {
        const pt = [s.line, +(r.attention.scores[s.line - 1] || 0).toFixed(3), s.text];
        if (unpairedIds.has(s.id)) unpaired.push(pt); else negatives.push(pt);
      } else if (s.type === 'must') {
        musts.push([s.line, +(r.attention.scores[s.line - 1] || 0).toFixed(3), s.text]);
      }
    }
    chart.setOption({
      animationDuration: 600,
      grid: { top: 28, left: 48, right: 20, bottom: 30 },
      tooltip: Object.assign(chartTooltip(), {
        trigger: 'item',
        formatter: (p) => {
          if (!p.value || !Array.isArray(p.value)) return '';
          const [line, , txt] = p.value;
          if (line == null) return '';
          return `<b>L${line}</b> · ${p.marker} ${p.seriesName}<div style="margin-top:4px;color:#9fb3cc;max-width:320px;white-space:normal">${esc(trunc(txt || lines[line - 1] || '', 120))}</div>`;
        }
      }),
      legend: { top: 0, right: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#8b98ad', fontSize: 11 }, inactiveColor: '#3d4a5f' },
      xAxis: { type: 'value', min: 1, max: N, name: 'line', nameTextStyle: { color: '#5b6b82' }, axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } }, axisLabel: { color: '#5b6b82', fontSize: 10 }, splitLine: { show: false } },
      yAxis: { type: 'value', min: 0, max: 1, name: 'attention', nameTextStyle: { color: '#5b6b82' }, axisLabel: { color: '#5b6b82', fontSize: 10, formatter: (v) => Math.round(v * 100) + '%' }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } } },
      series: [
        {
          name: 'attention', type: 'line', data: curve, showSymbol: false, smooth: 0.25, z: 2,
          lineStyle: { color: '#22d3ee', width: 2, shadowColor: 'rgba(34,211,238,0.4)', shadowBlur: 10 },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(34,211,238,0.30)' }, { offset: 1, color: 'rgba(34,211,238,0.02)' }]) },
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(251,113,133,0.055)' },
            label: { show: true, position: 'insideTop', color: 'rgba(251,113,133,0.75)', fontSize: 10, formatter: 'dead zone', distance: 6 },
            data: [[{ xAxis: Math.max(1, dz.startLine) }, { xAxis: Math.min(N, dz.endLine) }]]
          }
        },
        mkSeries('prohibitions', negatives, 'rgba(251,113,133,0.9)', 6),
        Object.assign(mkSeries('hard MUSTs', musts, 'rgba(251,191,36,0.95)', 8), { symbol: 'diamond' }),
        mkSeries('unpaired ✗', unpaired, '#fb7185', 13, { borderColor: 'rgba(255,255,255,0.85)', borderWidth: 1.5, shadowColor: 'rgba(251,113,133,0.9)', shadowBlur: 10 })
      ]
    });
    chart.on('click', (p) => { if (p.value && Array.isArray(p.value) && p.value[0] != null) jumpToLine(p.value[0]); });
    $('attentionModel').textContent = r.attention.model;
    const buried = r.buried;
    $('deadZoneNote').innerHTML = `Dead zone <b>lines ${dz.startLine}–${dz.endLine}</b> · attention floor ≈ ${Math.round((r.attention.scores[Math.floor(N / 2)] || 0) * 100)}% of peak` +
      (buried.length ? ` · <span class="t-neg"><b>${buried.length} critical rule${buried.length > 1 ? 's' : ''} buried here</b></span> (glowing markers)` : ' · no critical rules buried — good');
  }

  // ---------------------------------------------------------------- ledger
  function setFilter(f) {
    state.filter = f;
    document.querySelectorAll('#ledgerFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
    renderLedger();
  }

  function renderLedger() {
    const r = state.report;
    const unpairedIds = new Set(r.unpairedNegatives.map(u => u.id));
    let sents = r.sentences;
    if (state.filter === 'unpaired') sents = r.sentences.filter(s => unpairedIds.has(s.id));
    else if (state.filter !== 'all') sents = r.sentences.filter(s => s.type === state.filter);
    const box = $('ledger');
    if (!sents.length) { box.innerHTML = `<div style="padding:22px;text-align:center" class="muted">no instructions match this filter</div>`; return; }
    const frag = document.createDocumentFragment();
    for (const s of sents) {
      const row = document.createElement('div');
      row.className = 'lrow';
      let pairHtml;
      if (s.type === 'negative') {
        pairHtml = s.pairedWith == null ? '<span class="pair-bad">✗ no positive</span>'
          : (s.pairedWith === s.id ? '<span class="pair-ok">✓ inline swap</span>' : `<span class="pair-ok">✓ ${s.pairHow || 'paired'}</span>`);
      } else if (s.pairedWith != null && s.pairHow) pairHtml = '<span class="pair-meh">pairs a negative</span>';
      else pairHtml = '<span class="pair-meh">—</span>';
      const tableNote = s.table ? ' <span class="muted small">[table col]</span>' : '';
      row.innerHTML =
        `<span class="lline">L${s.line}</span>` +
        `<span class="type-badge ${s.type}">${s.type}</span>` +
        `<span class="ltext">${highlight(trunc(s.text, 220))}${tableNote}</span>` +
        `<span class="lpair">${pairHtml}</span>`;
      row.onclick = () => jumpToLine(s.line);
      frag.appendChild(row);
    }
    box.innerHTML = '';
    box.appendChild(frag);
  }

  // ---------------------------------------------------------------- conflicts / ribbon / radar / budgets / ideas
  function renderConflicts() {
    const r = state.report;
    const card = $('conflictCard');
    const staticConf = r.conflicts.map(c => ({ sev: c.severity, aLine: c.aLine, bLine: c.bLine, aText: c.aText, bText: c.bText, why: c.why, llm: false }));
    const llmConf = (r.llm && r.llm.entries || []).filter(e => e.kind === 'conflict').map(c => ({
      sev: 'llm', aLine: (c.lines || [])[0], bLine: (c.lines || [])[1],
      aText: (c.quote || '').split(' ↔ ')[0] || '', bText: (c.quote || '').split(' ↔ ')[1] || '', why: c.why, llm: true
    }));
    const all = staticConf.concat(llmConf);
    if (!all.length) { card.hidden = true; return; }
    card.hidden = false;
    $('conflictList').innerHTML = all.map(c => `
      <div class="conflict ${c.llm ? 'llm' : ''}">
        <div class="side"><div class="meta">L${c.aLine || '?'} ${c.llm ? '· LLM' : ''}</div>${esc(trunc(c.aText, 200))}</div>
        <div class="vs">↔</div>
        <div class="side"><div class="meta">L${c.bLine || '?'} ${c.llm ? '· LLM' : ''}</div>${esc(trunc(c.bText, 200))}</div>
        <div class="sev">${c.llm ? 'llm judgment' : c.sev + ' severity · '}conflict</div>
        <div class="why">${esc(c.why || '')}</div>
      </div>`).join('');
  }

  function renderRibbon() {
    const r = state.report;
    const ribbon = $('sectionRibbon');
    ribbon.innerHTML = '';
    for (const sec of r.sections) {
      const lines = Math.max(1, sec.endLine - sec.startLine + 1);
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.flexGrow = String(lines);
      seg.style.background = ROLE_COLORS[sec.role] || ROLE_COLORS.general;
      seg.title = `${sec.title || sec.role} · L${sec.startLine}–${sec.endLine} · ${lines} lines · ${sec.role}`;
      seg.onclick = () => jumpToLine(Math.max(1, sec.startLine));
      ribbon.appendChild(seg);
    }
    const used = new Set(r.sections.map(s => s.role));
    $('ribbonLegend').innerHTML = ROLE_ORDER.filter(ro => used.has(ro)).map(ro => `<span><i style="background:${ROLE_COLORS[ro]}"></i>${ro}</span>`).join('');
  }

  function renderRadar() {
    const r = state.report;
    const el = $('radarChart');
    if (state.charts.radar) state.charts.radar.dispose();
    const chart = echarts.init(el);
    state.charts.radar = chart;
    const checks = r.description.checks;
    chart.setOption({
      tooltip: Object.assign(chartTooltip(), {
        formatter: (p) => {
          const c = checks[p.dataIndex];
          return `<b>${c.axis}</b> · ${c.score}/100<div style="margin-top:4px;color:#9fb3cc;max-width:260px;white-space:normal">${esc(c.message)}</div>`;
        }
      }),
      radar: {
        indicator: checks.map(c => ({ name: c.axis, max: 100 })),
        radius: '68%', center: ['50%', '52%'],
        axisName: { color: '#8b98ad', fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
        splitArea: { areaStyle: { color: ['rgba(148,163,184,0.02)', 'rgba(148,163,184,0.05)'] } },
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.15)' } }
      },
      series: [{
        type: 'radar',
        data: [{
          value: checks.map(c => c.score), name: 'description quality',
          areaStyle: { color: 'rgba(34,211,238,0.18)' }, lineStyle: { color: '#22d3ee', width: 2 },
          itemStyle: { color: '#a5f3fc' }, symbolSize: 5
        }]
      }]
    });
    $('descChecks').innerHTML = checks.map(c => `
      <div class="dcheck ${c.ok ? 'ok' : 'bad'}">
        <span class="ic">${c.ok ? '✓' : '✗'}</span>
        <span class="msg"><b>${c.axis}</b> — ${esc(c.message)}${c.ok ? '' : `<span class="hint">${esc(c.hint || '')}</span>`}</span>
      </div>`).join('');
    renderDescText();
  }

  function renderDescText() {
    const r = state.report;
    const d = r.meta.description || '(no description — this skill will never auto-trigger)';
    let html = esc(d);
    html = html.replace(/"([^"]{4,})"/g, '<mark class="quote-trig">"$1"</mark>');
    html = html.replace(/\b(I|me|my|we|our|us)\b/g, '<mark class="fp">$1</mark>');
    html = html.replace(/\byou (can|should|will)\b/gi, '<mark class="fp">you $1</mark>');
    html = html.replace(/\b(use (?:this |it |these )?(?:skill |plugin )?(?:on|when|for|to|whenever))\b/gi, '<mark class="quote-trig">$1</mark>');
    $('descText').innerHTML = html;
  }

  function renderBudgets() {
    const r = state.report, s = r.stats, C = SkillAnalyzer.constants;
    const bar = (pct, color) => `<div class="bar"><div class="fill" style="width:${Math.min(100, pct)}%;background:${color}"></div></div>`;
    const colorFor = (frac) => frac > 0.95 ? 'linear-gradient(90deg,#fb7185,#f43f5e)' : frac > 0.75 ? 'linear-gradient(90deg,#fbbf24,#f59e0b)' : 'linear-gradient(90deg,#34d399,#10b981)';
    const capAt = (pos) => `<span class="cap" style="left:${Math.min(100, pos)}%"></span>`;
    const bodyFrac = s.bodyLines / C.BODY_LINE_BUDGET;
    const tokFrac = s.estTokens / C.BODY_TOKEN_BUDGET;
    const descLen = (r.meta.description || '').length + (r.meta.whenToUse || '').length;
    const descFrac = descLen / C.CC_LISTING_LIMIT;
    const negMax = Math.max(12, s.negDensityPer1k * 1.35);
    const negFrac = s.negDensityPer1k / negMax;
    $('budgets').innerHTML = `
      <div class="budget">
        <div class="b-head"><span>body lines</span><span><b>${s.bodyLines}</b> <span class="b-of">/ ${C.BODY_LINE_BUDGET}</span></span></div>
        ${bar(bodyFrac * 100, colorFor(bodyFrac))}${capAt(100)}
        <p class="b-note">${bodyFrac > 1 ? 'over budget — split into references/' : bodyFrac > 0.75 ? 'approaching the split point' : 'SKILL.md stays a table of contents'}</p>
      </div>
      <div class="budget">
        <div class="b-head"><span>body tokens (est.)</span><span><b>≈${s.estTokens}</b> <span class="b-of">/ ${C.BODY_TOKEN_BUDGET}</span></span></div>
        ${bar(tokFrac * 100, colorFor(tokFrac))}${capAt(100)}
        <p class="b-note">words × 1.3 · over budget means every turn re-pays it (skill stays in context)</p>
      </div>
      <div class="budget">
        <div class="b-head"><span>negation density</span><span><b>${s.negDensityPer1k}</b> <span class="b-of">/ 1k words</span></span></div>
        ${bar(negFrac * 100, s.negDensityPer1k > C.CORPUS_NEG_DENSITY_BASELINE ? 'linear-gradient(90deg,#fb7185,#f43f5e)' : 'linear-gradient(90deg,#34d399,#10b981)')}<span class="base" style="left:${(C.CORPUS_NEG_DENSITY_BASELINE / negMax) * 100}%"></span>
        <p class="b-note">corpus baseline ${C.CORPUS_NEG_DENSITY_BASELINE}/1k (283-skill survey) — amber mark · high density ⇒ consider positives</p>
      </div>
      <div class="budget">
        <div class="b-head"><span>description + when_to_use</span><span><b>${descLen}</b> <span class="b-of">/ ${C.CC_LISTING_LIMIT} chars</span></span></div>
        ${bar(descFrac * 100, colorFor(descFrac))}${capAt((C.DESCRIPTION_CHAR_LIMIT / C.CC_LISTING_LIMIT) * 100)}${capAt(100)}
        <p class="b-note">API hard limit ${C.DESCRIPTION_CHAR_LIMIT} · Claude Code truncates the listing at ${C.CC_LISTING_LIMIT}</p>
      </div>`;
  }

  function renderIdeas() {
    const r = state.report;
    const ideas = r.ideas.slice();
    if (r.llm && r.llm.entries && r.llm.entries.length) {
      for (const e of r.llm.entries) {
        ideas.push({
          severity: e.severity === 'high' ? 'high' : e.severity === 'medium' ? 'medium' : 'low',
          llm: true,
          title: `LLM: ${e.kind.replace(/_/g, ' ')}${e.line ? ' — L' + e.line : ''}`,
          detail: (e.quote ? '"' + trunc(e.quote, 160) + '" — ' : '') + (e.suggested ? `<span class="t-pos">suggested positive: “${esc(e.suggested)}”</span>` : '') + esc(e.why || ''),
          lines: e.line ? [e.line] : (e.lines || []),
          citation: 'LLM review'
        });
      }
    }
    ideas.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);
    $('ideaCount').textContent = ideas.length + ' generated · ordered by severity';
    $('ideas').innerHTML = ideas.length ? ideas.map(i => `
      <div class="idea ${i.severity}${i.llm ? ' llm' : ''}">
        <div class="stripe"></div>
        <div>
          <p class="i-title">${esc(i.title)}</p>
          <p class="i-detail">${i.detail}</p>
          <div class="i-meta">
            ${(i.lines || []).slice(0, 12).map(l => `<span class="lineref" data-line="${l}">L${l}</span>`).join('')}
            ${i.citation ? `<span class="cite">${esc(i.citation)}</span>` : ''}
          </div>
        </div>
      </div>`).join('') : '<p class="muted" style="margin:6px 0">no improvement ideas — this skill is clean by every static check</p>';
    $('ideas').querySelectorAll('.lineref').forEach(el => { el.onclick = () => jumpToLine(parseInt(el.dataset.line, 10)); });
  }

  function scrollToCard(id) {
    const el = typeof id === 'string' ? $(id) : id;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------- LLM review (OpenRouter, BYOK)
  function llmModel() {
    const sel = $('llmModel').value;
    return sel === 'custom' ? ($('llmModelCustom').value.trim() || 'moonshotai/kimi-k3') : sel;
  }

  async function runLlm() {
    const key = $('llmKey').value.trim();
    if (!key) { toast('Add your OpenRouter API key first (stored in this browser only)', true); $('llmKey').focus(); return; }
    localStorage.setItem('or_key', key);
    localStorage.setItem('or_model', $('llmModel').value);
    const status = $('llmStatus');
    const btn = $('btnLlmRun');
    btn.disabled = true;
    status.hidden = false;
    status.textContent = `running ${llmModel()} over ${state.report.stats.totalLines} lines… (a cheap model, usually 10–30 s)`;
    const prompt = SkillAnalyzer.llmPrompt(state.report);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llmModel(),
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${trunc(body, 180)}`);
      }
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('empty response from model');
      const applied = SkillAnalyzer.applyLlmOverlay(state.report, content, state.raw);
      if (!applied.ok) throw new Error('model did not return valid JSON — try again or pick a stronger model');
      renderConflicts(); renderIdeas(); renderLlmResults(); renderSummary();
      status.textContent = `done · ${applied.entries.length} findings merged below`;
      toast(`LLM review merged · ${applied.entries.length} findings`);
    } catch (e) {
      status.textContent = 'failed: ' + e.message;
      toast('LLM review failed — see status line', true);
    } finally {
      btn.disabled = false;
    }
  }

  function renderLlmResults() {
    const r = state.report;
    const box = $('llmResults');
    if (!r.llm || !r.llm.applied) { box.hidden = true; return; }
    box.hidden = false;
    const entries = r.llm.entries;
    box.innerHTML =
      (r.llm.strengths && r.llm.strengths.length
        ? `<div class="llm-entry"><div class="kind">strengths</div><ul class="llm-strengths" style="margin:6px 0 0;padding-left:18px">${r.llm.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`
        : '') +
      entries.map(e => `
        <div class="llm-entry">
          <div class="kind">${e.kind.replace(/_/g, ' ')}${e.line ? ' · L' + e.line : ''}</div>
          <div>${esc(trunc(e.quote || '', 160))}</div>
          ${e.suggested ? `<div class="sugg">→ ${esc(e.suggested)}</div>` : ''}
          <div class="muted small" style="margin-top:3px">${esc(e.why || '')}</div>
        </div>`).join('') +
      (r.llm.notes ? `<p class="muted small" style="margin:4px 0 0">${esc(r.llm.notes)}</p>` : '');
  }

  // ---------------------------------------------------------------- events
  async function handleUrl(input) {
    const url = (typeof input === 'string' ? input : $('urlInput').value).trim();
    if (!url) return;
    toast('loading…');
    try {
      const res = await fetchSkillsFromUrl(url);
      if (res.error) { toast(res.error, true); return; }
      loadSkills(res.skills, trunc(url, 60), res.truncated);
      if (res.truncated) toast(`Loaded first ${res.skills.length} of ${res.truncated} skills`, true);
    } catch (e) {
      toast('Could not load: ' + e.message, true);
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList);
    const skills = files.filter(f => /(^|\/)SKILL\.md$/i.test(f.name) || (/\.md$/i.test(f.name) && !files.some(g => /(^|\/)SKILL\.md$/i.test(g.name) && g !== f) && skillsOnlyMd(files, f)));
    const picked = skills.length ? skills : files.filter(f => /\.md$/i.test(f.name));
    if (!picked.length) { toast('No .md files found', true); return; }
    let loaded = 0;
    const list = [];
    let pending = picked.length;
    picked.forEach(f => {
      const fr = new FileReader();
      fr.onload = () => {
        list.push({ name: nameFromFile(f.name), raw: String(fr.result) });
        if (++loaded === pending) loadSkills(list, picked.length === 1 ? f.name : `${picked.length} files`);
      };
      fr.readAsText(f);
    });
  }
  function skillsOnlyMd(files, f) { return files.length === 1; }

  function bindEvents() {
    $('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFiles(e.target.files); e.target.value = ''; });
    $('folderInput').addEventListener('change', (e) => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; });
    $('btnOpen').onclick = () => $('fileInput').click();
    $('btnFolder').onclick = () => $('folderInput').click();
    $('dropzone').onclick = (e) => { if (e.target.tagName !== 'BUTTON') $('fileInput').click(); };
    $('btnPasteEmpty').onclick = (e) => { e.stopPropagation(); openModal('Paste SKILL.md contents', (text) => { if (text.trim()) loadSkill(text, 'pasted.md'); }); };
    $('btnPaste').onclick = () => openModal('Paste SKILL.md contents', (text) => { if (text.trim()) loadSkill(text, 'pasted.md'); });

    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    $('btnReset').onclick = showEmpty;
    $('btnLoadUrl').onclick = () => handleUrl();
    $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUrl(); });
    $('urlInput').addEventListener('paste', () => setTimeout(() => handleUrl(), 60));

    document.querySelectorAll('[data-sample]').forEach(b => {
      b.onclick = () => loadSkill(SkillSamples[b.dataset.sample], b.dataset.sample + ' (sample)');
    });
    document.querySelectorAll('[data-url]').forEach(b => { b.onclick = () => handleUrl(b.dataset.url); });

    $('ledgerFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) setFilter(chip.dataset.filter);
    });

    $('llmModel').addEventListener('change', () => { $('llmModelCustom').hidden = $('llmModel').value !== 'custom'; });
    $('btnLlmRun').onclick = runLlm;
    $('btnLlmPrompt').onclick = async () => {
      try { await navigator.clipboard.writeText(SkillAnalyzer.llmPrompt(state.report)); toast('Analysis prompt copied — paste it into any LLM'); }
      catch (e) { openModal('Copy this prompt', () => {}, SkillAnalyzer.llmPrompt(state.report), true); }
    };
    $('btnLlmApply').onclick = () => {
      const json = $('llmJson').value;
      if (!json.trim()) { toast('Paste the LLM JSON first', true); return; }
      const res = SkillAnalyzer.applyLlmOverlay(state.report, json, state.raw);
      if (!res.ok) { toast('Could not parse JSON: ' + res.error, true); return; }
      renderConflicts(); renderIdeas(); renderLlmResults(); renderSummary();
      toast(`LLM overlay applied · ${res.entries.length} entries merged`);
    };

    $('btnCopyRaw').onclick = async () => {
      try { await navigator.clipboard.writeText(state.raw); toast('Raw markdown copied'); }
      catch (e) { toast('Clipboard blocked', true); }
    };

    window.addEventListener('resize', () => { Object.values(state.charts).forEach(c => c.resize()); });

    // restore LLM settings
    const savedKey = localStorage.getItem('or_key');
    if (savedKey) $('llmKey').value = savedKey;
    const savedModel = localStorage.getItem('or_model');
    if (savedModel) { $('llmModel').value = savedModel; $('llmModelCustom').hidden = savedModel !== 'custom'; }
  }

  function openModal(title, onOk, prefill, readOnly) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(4,8,16,.7);backdrop-filter:blur(6px);z-index:100;display:grid;place-items:center;padding:24px;';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'width:min(720px,100%);max-height:80vh;display:flex;flex-direction:column;gap:12px;';
    card.innerHTML = `<h2 style="margin:0;font-size:16px">${esc(title)}</h2>`;
    const ta = document.createElement('textarea');
    ta.style.cssText = 'flex:1;min-height:260px;resize:vertical;font-family:var(--mono);font-size:12px;color:var(--text);background:rgba(7,11,20,.7);border:1px solid var(--border);border-radius:10px;padding:12px;outline:none;line-height:1.5;';
    if (prefill) ta.value = prefill;
    if (readOnly) ta.readOnly = true;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.className = 'btn ghost'; cancel.textContent = 'close';
    cancel.onclick = () => overlay.remove();
    row.appendChild(cancel);
    if (!readOnly) {
      const ok = document.createElement('button');
      ok.className = 'btn'; ok.textContent = 'analyze';
      ok.onclick = () => { onOk(ta.value); overlay.remove(); };
      row.appendChild(ok);
    }
    card.appendChild(ta); card.appendChild(row); overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    if (!readOnly) ta.focus();
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    bindEvents();
    const url = new URLSearchParams(location.search).get('url');
    const sample = new URLSearchParams(location.search).get('sample');
    if (url) handleUrl(url);
    else if (sample && SkillSamples[sample]) loadSkill(SkillSamples[sample], sample + ' (sample)');
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
