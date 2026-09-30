/*!
 * Skill Analyzer — static heuristic analysis engine for SKILL.md agent skills.
 * UMD: works in browser (global SkillAnalyzer) and Node (module.exports).
 * Dependencies are injected: markdown-it instance + js-yaml.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/markdown-it.min.js'), require('./vendor/js-yaml.min.js'));
  else root.SkillAnalyzer = factory(root.markdownit, root.jsyaml);
})(typeof self !== 'undefined' ? self : this, function (markdownit, jsyaml) {
  'use strict';

  // ------------------------------------------------------------------ constants

  const CORPUS_NEG_DENSITY_BASELINE = 6.2; // per 1000 words, measured over ~283-skill corpus
  const BODY_LINE_BUDGET = 500;            // Anthropic best practices
  const BODY_TOKEN_BUDGET = 5000;          // Anthropic skills overview
  const DESCRIPTION_CHAR_LIMIT = 1024;      // API path hard limit
  const CC_LISTING_LIMIT = 1536;            // Claude Code listing truncation (description + when_to_use)
  const NAME_MAX = 64;

  const SPEC_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
  const CC_EXT_KEYS = ['when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation',
    'user-invocable', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell'];
  const KNOWN_KEYS = new Set([...SPEC_KEYS, ...CC_EXT_KEYS]);

  const STOPWORDS = new Set(('a,an,the,and,or,but,if,then,else,when,whenever,where,while,of,to,in,on,for,with,without,from,by,at,as,is,are,was,were,be,been,being,it,its,this,that,these,those,you,your,yours,i,me,my,we,our,us,they,them,their,he,she,his,her,not,no,nor,so,than,too,very,can,could,should,would,may,might,must,shall,will,do,does,did,done,doing,have,has,had,having,use,used,using,make,makes,made,also,more,most,other,some,any,each,every,all,both,few,many,such,same,only,own,just,now,here,there,up,down,out,off,over,under,again,further,once,because,until,against,about,between,into,through,during,before,after,above,below,what,which,who,whom,why,how,dont,doesnt,arent,isnt,wont,cant,per,e.g,i.e,etc,vs,and/or,youre,please,instead,rather,unless,never,avoid,stop,skip,omit,remove,delete,drop,forbid,forbidden,forbids,donts,its').split(','));

  const NEG_RES = [
    /\bdon['’]t\b/i, /\bdo\s+not\b/i, /\bnever\b/i, /\bavoid\s+/i, /\bstop\s+\w+ing\b/i,
    /\bskip\b/i, /\bomit\b/i, /\bforbid\w*/i, /\bnot\s+(?:use|run|include|add|create|call|write|ask|send)\b/i,
    /\bno\s+(?:need|more)\b/i, /\bremove\s+(?:the|this|these|any|all|boldface|em|most|excessive)\b/i,
    /\bdelete\s+(?:the|this|these|any|fragmented|most)\b/i, /\bdrop\s+(?:the|this|these|it|any|all|hyphens)\b/i,
    /\binstead\s+of\b/i, /\brather\s+than\b/i
  ];
  const NEG_MARKER_RES = [
    /\bdon['’]t\b/i, /\bdo\s+not\b/i, /\bnever\b/i, /\bavoid\b/i, /\bskip\b/i, /\bomit\b/i,
    /\bstop\s+\w+ing\b/i, /\bremove\b/i, /\bdelete\b/i, /\bdrop\b/i, /\bforbid\w*/i, /\binstead\s+of\b/i
  ];
  const MUST_RES = [/\bmust\b/i, /\balways\b/i, /\bmandatory\b/i, /\brequired\b/i, /\bensure\b/i, /\bimportant(?:ly)?\b/i, /\bcritical(?:ly)?\b/i];
  const CAPS_WORD_RE = /\b(MUST|ALWAYS|NEVER|IMPORTANT|CRITICAL|REQUIRED|MANDATORY|EXACTLY|ONLY|DO NOT|DOES NOT|WARNING)\b/;

  const IMPERATIVE_VERBS = new Set(('use,run,check,read,write,add,create,make,keep,prefer,apply,follow,show,set,call,open,find,fix,build,generate,include,cite,quote,list,scan,put,place,name,ask,produce,return,send,record,note,treat,consider,start,end,finish,verify,validate,test,install,update,copy,move,group,collapse,split,break,derive,limit,cap,load,fetch,paste,drop,strip,cut,trim,preserve,maintain,generalize,reframe,replace,swap,turn,neutralize,reword,rephrase,explain,state,mention,highlight,front,front-load,embed,publish,commit,push,review,audit,improve,polish,pair,match,measure,track,report,log,inspect,walk,step,repeat,iterate,choose,pick,select,mark,label,tag,wrap,unwrap,join,merge,deduplicate,prune,scaffold,draft,revise,rewrite,edit,delete,remove,format,render,display,present,summarize,extract,parse,convert,transform,compute,calculate,count,total,rank,score,grade,weigh,deduct,clamp,normalize,clean,escape,sanitize,link,reference,attach,save,store,cache,defer,await,prompt,trigger,invoke,enable,disable,ensure,assume,model,encode,emit,respond,reply,answer,say,speak,talk,sound,look,feel,listen,watch,observe,study,learn,teach,guide,help,support,allow,permit,block,prevent,protect,guard,fence,scope,bound,leave,carry,inherit,request,prompt,recommend,reconcile,seed,wait,reuse,hand,present,log,mention,summarize,let,take,judge,map,name,shape,give,restate,sharpen,teach,shrink,split,guard').split(','));

  const SECTION_ROLES = [
    { role: 'guardrails', re: /^(anti[- ]?patterns?|pitfalls?|gotchas?|mistakes?|avoid|don'?ts?|never|warnings?|guardrails?|failure modes?)\b|anti[- ]?pattern|avoid these|common mistakes/i },
    { role: 'process', re: /^\d+[.)]?\s+\S/ },
    { role: 'process', re: /^(process|steps?|workflow|how to|usage|instructions?|guide|procedure|run|execution|phases?|loop|when you|how)\b/i },
    { role: 'output', re: /^(output|deliverables?|format|result|artifacts?|what you(?:'ll)? (?:get|produce)|finished)\b/i },
    { role: 'examples', re: /^(examples?|samples?|sample output|worked example)\b/i },
    { role: 'reference', re: /^(references?|appendix|resources?|glossary|see also|further reading|external)\b/i },
    { role: 'scope', re: /^(scope|in scope|out of scope|boundaries|non[- ]?goals?)\b/i },
    { role: 'rules', re: /^(rules?|principles?|style|voice|tone|guidelines?|standards?|constraints?)\b/i },
    { role: 'context', re: /^(context|background|overview|intro(?:duction)?|about|what|why|purpose)\b/i }
  ];

  const PAIR_FOLLOWERS = /^(instead|rather|use|prefer|try|replace|swap|write|switch|if)\b/i;

  // ------------------------------------------------------------------ helpers

  function words(text) {
    return (text || '').toLowerCase().match(/[a-z][a-z'’-]*/g) || [];
  }
  function contentWords(text) {
    return words(text).map(w => w.replace(/['’]/g, '')).filter(w => w.length > 2 && !STOPWORDS.has(w));
  }
  function stem(w) {
    return w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '');
  }
  function contentSet(text) {
    const s = new Set();
    for (const w of contentWords(text)) s.add(stem(w));
    return s;
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function countMatches(text, res) {
    let n = 0;
    for (const re of res) { const m = text.match(new RegExp(re.source, 'gi')); if (m) n += m.length; }
    return n;
  }

  // ------------------------------------------------------------------ frontmatter

  function splitFrontmatter(raw) {
    const lines = raw.split(/\r?\n/);
    if (lines[0] !== '---') return { fmRaw: null, body: raw, headerLines: 0, fmData: null, fmError: null };
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) { end = i; break; }
    }
    if (end === -1) return { fmRaw: null, body: raw, headerLines: 0, fmData: null, fmError: 'Closing --- not found; whole file treated as body.' };
    const fmRaw = lines.slice(1, end).join('\n');
    const body = lines.slice(end + 1).join('\n');
    let fmData = null, fmError = null;
    try { fmData = fmRaw.trim() ? jsyaml.load(fmRaw) : {}; } catch (e) { fmError = String(e.message || e); }
    return { fmRaw, body, headerLines: end + 1, fmData, fmError };
  }

  function auditFrontmatter(fmData, fmError, headerLines) {
    const issues = [];
    const unknown = [];
    if (fmError) {
      issues.push({ severity: 'high', key: 'yaml', message: 'Frontmatter YAML failed to parse — skill will load with no fields set.', hint: 'Fix the YAML syntax; the opening --- must be the first line.' });
    }
    const data = fmData && typeof fmData === 'object' ? fmData : {};
    for (const k of Object.keys(data)) if (!KNOWN_KEYS.has(k)) unknown.push(k);
    if (unknown.length) {
      issues.push({ severity: 'low', key: 'unknown-keys', message: `Unknown frontmatter key(s): ${unknown.join(', ')}.`, hint: 'Spec-safe keys: ' + SPEC_KEYS.join(', ') + '. Claude Code extensions are silently ignored by other agents.' });
    }
    if (headerLines > 0) {
      if (!data.name) issues.push({ severity: 'high', key: 'name', message: 'Missing required field: name.', hint: 'Add name (lowercase, hyphens, ≤64 chars).' });
      if (!data.description) issues.push({ severity: 'high', key: 'description', message: 'Missing required field: description.', hint: 'The description is the entire triggering surface — it is always loaded (~100 tokens).' });
    }
    if (data.name) {
      const n = String(data.name);
      if (n.length > NAME_MAX) issues.push({ severity: 'high', key: 'name', message: `name is ${n.length} chars (max ${NAME_MAX}).`, hint: 'Shorten the name.' });
      if (!/^[a-z0-9-]+$/.test(n)) issues.push({ severity: 'medium', key: 'name', message: 'name should be lowercase letters, numbers and hyphens only.', hint: `Got: ${n}` });
      if (/anthropic|claude/.test(n)) issues.push({ severity: 'high', key: 'name', message: 'name contains reserved word (anthropic/claude).', hint: 'Rename the skill.' });
    }
    if (data.description) {
      const d = String(data.description);
      if (d.length > DESCRIPTION_CHAR_LIMIT) issues.push({ severity: 'high', key: 'description', message: `description is ${d.length} chars (API limit ${DESCRIPTION_CHAR_LIMIT}).`, hint: 'Trim the description.' });
      const combined = d.length + (data.when_to_use ? String(data.when_to_use).length : 0);
      if (combined > CC_LISTING_LIMIT) issues.push({ severity: 'medium', key: 'description', message: `description${data.when_to_use ? ' + when_to_use' : ''} is ${combined} chars — Claude Code truncates the listing at ${CC_LISTING_LIMIT}.`, hint: 'Trim so the full trigger text survives listing truncation.' });
    }
    if (data.compatibility && String(data.compatibility).length > 500) {
      issues.push({ severity: 'low', key: 'compatibility', message: 'compatibility field exceeds 500 chars.', hint: 'Trim.' });
    }
    return { issues, unknown };
  }

  // ------------------------------------------------------------------ structure

  function parseStructure(mdInstance, body, headerLines) {
    // absolute 1-based line for a body-relative 0-based line:
    const abs = (bodyLine) => bodyLine + headerLines + 1;
    const tokens = mdInstance.parse(body, {});
    const blocks = [];   // {kind, startLine, endLine, text, level, cells}
    const sections = [];
    const codeBlocks = [];
    const links = [];
    let headingStack = [];
    let currentTr = null;
    let tableHeaders = null;
    let pendingBlock = null; // last open block awaiting its inline
    let listDepth = 0;

    const pushSection = (title, level, startLine) => {
      // close previous sections of same-or-higher level
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        const s = headingStack.pop();
        s.endLine = startLine - 1;
      }
      const sec = { title, level, startLine, endLine: null, role: classifySection(title) };
      sections.push(sec);
      headingStack.push(sec);
    };

    const finishSections = (lastLine) => {
      while (headingStack.length) { const s = headingStack.pop(); s.endLine = lastLine; }
    };

    if (headerLines > 0) {
      sections.push({ title: '(frontmatter)', level: 0, startLine: 1, endLine: headerLines, role: 'frontmatter' });
    }

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      if (t.type === 'heading_open') {
        const level = parseInt(t.tag.slice(1), 10);
        const inlineTok = tokens[i + 1];
        const title = inlineTok && inlineTok.type === 'inline' ? inlineTok.content.trim() : '';
        const start = abs(t.map ? t.map[0] : 0);
        pushSection(title, level, start);
        blocks.push({ kind: 'heading', startLine: start, endLine: abs((t.map ? t.map[1] : 1) - 1), text: title, level, section: sections[sections.length - 1] });
        i++; // skip inline
        continue;
      }
      if (t.type === 'fence' || t.type === 'code_block') {
        const cb = { kind: 'code', lang: (t.info || '').trim(), startLine: abs(t.map ? t.map[0] : 0), endLine: abs((t.map ? t.map[1] : 1) - 1), text: t.content };
        codeBlocks.push(cb);
        blocks.push(cb);
        continue;
      }
      if (t.type === 'html_block') {
        blocks.push({ kind: 'html', startLine: abs(t.map ? t.map[0] : 0), endLine: abs((t.map ? t.map[1] : 1) - 1), text: t.content, section: topSection(headingStack) });
        continue;
      }
      if (t.type === 'table_open') { currentTr = null; tableHeaders = null; }
      if (t.type === 'thead_open') tableHeaders = [];
      if (t.type === 'tr_open') {
        currentTr = { kind: 'table_row', startLine: abs(t.map ? t.map[0] : 0), endLine: abs((t.map ? t.map[1] : 1) - 1), cells: [], section: topSection(headingStack) };
      }
      if (t.type === 'th_open' || t.type === 'td_open') { pendingBlock = currentTr; }
      if (t.type === 'list_item_open') listDepth++;
      if (t.type === 'list_item_close') listDepth = Math.max(0, listDepth - 1);
      if (t.type === 'inline' && t.content) {
        // gather links
        const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
        let lm;
        while ((lm = linkRe.exec(t.content))) links.push({ text: lm[1], href: lm[2], line: abs(t.map ? t.map[0] : 0) });

        if (pendingBlock && (tokens[i - 1].type === 'th_open' || tokens[i - 1].type === 'td_open')) {
          pendingBlock.cells.push(t.content.trim());
          continue;
        }
        pendingBlock = null;
        const parent = tokens[i - 1];
        let kind = 'paragraph';
        if ((parent && parent.type === 'list_item_open') || listDepth > 0) kind = 'list_item';
        if (t.map) {
          blocks.push({ kind, startLine: abs(t.map[0]), endLine: abs(t.map[1] - 1), text: t.content, section: topSection(headingStack) });
        }
        continue;
      }
      if (t.type === 'tr_close' && currentTr) {
        if (tableHeaders && tableHeaders.length === 0) {
          tableHeaders = currentTr.cells.slice();
          currentTr.isHeader = true;
        }
        currentTr.headerRow = tableHeaders;
        if (currentTr.cells.length && !currentTr.isHeader) blocks.push(currentTr);
        currentTr = null;
        pendingBlock = null;
      }
    }
    // close trailing table row if unbalanced
    if (currentTr && currentTr.cells.length) blocks.push(currentTr);
    finishSections(headerLines + body.split(/\r?\n/).length);
    return { blocks, sections, codeBlocks, links };
  }

  function topSection(stack) { return stack.length ? stack[stack.length - 1] : null; }

  function classifySection(title) {
    for (const { role, re } of SECTION_ROLES) if (re.test(title)) return role;
    return 'general';
  }

  // ------------------------------------------------------------------ sentences

  function splitSentences(text) {
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(\[`*])+/);
    return parts.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 8 && /[a-zA-Z]/.test(s));
  }

  function sentenceLine(blockText, sentence) {
    const idx = blockText.indexOf(sentence.slice(0, 30).replace(/\s+/g, ' '));
    if (idx === -1) return 0;
    return (blockText.slice(0, idx).match(/\n/g) || []).length;
  }

  function extractSentences(blocks) {
    const sentences = [];
    let id = 0;
    for (const b of blocks) {
      if (b.kind === 'heading' || b.kind === 'code' || b.kind === 'html') continue;
      if (b.kind === 'table_row') {
        b.cells.forEach((cell, ci) => {
          const clean = cell.replace(/\s+/g, ' ').trim();
          if (clean.length < 5) return;
          sentences.push(mkSentence(id++, clean, b.startLine, b, { table: true, cellIndex: ci, cells: b.cells, headerRow: b.headerRow }));
        });
        continue;
      }
      const raw = b.text;
      const sents = splitSentences(raw);
      for (const s of sents) {
        sentences.push(mkSentence(id++, s, b.startLine + sentenceLine(raw, s), b, {}));
      }
    }
    return sentences;
  }

  function mkSentence(id, text, line, block, extra) {
    return Object.assign({
      id, text, line, endLine: line, section: block.section || null,
      sectionTitle: block.section ? block.section.title : '(intro)',
      blockKind: block.kind,
      type: 'neutral', markers: [], mustMarkers: [], capsMarkers: [],
      pairedWith: null, pairHow: null, mainVerb: null, negatedVerb: null,
      contentSet: contentSet(text)
    }, extra);
  }

  // ------------------------------------------------------------------ classification

  function classifySentence(s) {
    const t = s.text;
    const negHits = [];
    for (const re of NEG_RES) { const m = t.match(re); if (m) negHits.push(m[0]); }
    const mustHits = [];
    for (const re of MUST_RES) { const m = t.match(re); if (m) mustHits.push(m[0]); }
    const capsHits = t.match(new RegExp(CAPS_WORD_RE.source, 'g')) || [];

    const firstWord = (t.match(/^[“"'(\[]*([A-Za-z][a-z'’-]*)/) || [])[1];
    const startsImperative = firstWord ? IMPERATIVE_VERBS.has(firstWord.toLowerCase()) : false;

    // negated verb: word right after the negation marker
    let negatedVerb = null;
    const negVerbRe = /(?:don['’]t|do\s+not|never|avoid|stop\s+\w+ing|skip|omit)\s+(?:the\s+|a\s+|any\s+|it\s+|to\s+)?([a-z]+)\b/i;
    const nvm = t.match(negVerbRe);
    if (nvm) negatedVerb = stem(nvm[1].toLowerCase());

    s.markers = negHits;
    s.mustMarkers = mustHits;
    s.capsMarkers = capsHits;
    s.mainVerb = firstWord ? firstWord.toLowerCase() : null;
    s.negatedVerb = negatedVerb;
    s.startsImperative = startsImperative;

    // table column context: the column header carries the polarity
    // (e.g. tweeting's Swap table: "Instead of | Write")
    if (s.table && s.headerRow && s.headerRow.length && s.cellIndex < s.headerRow.length) {
      const header = String(s.headerRow[s.cellIndex] || '').trim();
      if (/instead\s*of|don['’]?t|avoid|never|bad|stop|less|wrong/i.test(header)) {
        s.type = 'negative'; s.subtype = 'table-column';
        s.markers = s.markers.concat([`column: "${header}"`]);
        return s;
      }
      if (/^(write|do|use|prefer|good|better|swap|instead write)/i.test(header)) {
        s.type = 'positive'; s.subtype = 'table-column';
        return s;
      }
    }

    if (negHits.length) {
      s.type = 'negative';
      if (startsImperative && /\binstead|rather\b/i.test(t)) s.subtype = 'swap'; // "Use X instead of Y"
      else if (startsImperative && s.mainVerb && !new RegExp('\\b' + s.mainVerb + '\\b\\s*$', 'i').test(t)) s.subtype = 'mixed';
      else s.subtype = 'plain';
    } else if (mustHits.length || capsHits.length) {
      s.type = 'must';
    } else if (startsImperative) {
      s.type = 'positive';
    } else {
      // weaker positive: "X should be Y", "prefer X" anywhere, "ensure" mid-sentence
      s.type = /\b(prefer|ensure|keep|include)\b/i.test(t) ? 'positive' : 'neutral';
      if (s.type === 'positive') s.weak = true;
    }
    return s;
  }

  // ------------------------------------------------------------------ pairing

  function pairInstructions(sentences) {
    const negatives = sentences.filter(s => s.type === 'negative');
    const positives = sentences.filter(s => s.type === 'positive' || s.type === 'must');
    const pairs = [];
    const unpaired = [];

    for (const n of negatives) {
      // (a) inline swap / mixed sentence — contains its own positive
      if (n.subtype === 'swap' || n.subtype === 'mixed') {
        n.pairedWith = n.id; n.pairHow = 'inline';
        pairs.push({ negativeId: n.id, positiveId: n.id, how: 'inline' });
        continue;
      }
      // (b) table row: a positive cell in the same row
      if (n.table) {
        const mate = positives.find(p => p.table && p.line === n.line && p.id !== n.id);
        if (mate) {
          n.pairedWith = mate.id; n.pairHow = 'table-row';
          mate.pairedWith = n.id; mate.pairHow = 'table-row';
          pairs.push({ negativeId: n.id, positiveId: mate.id, how: 'table-row' });
          continue;
        }
      }
      // (c) structural adjacency: the next sentence in the same block is the stated replacement
      const nextById = sentences[n.id + 1];
      if (nextById && nextById.type !== 'negative' && (nextById.line === n.line || nextById.line === n.line + 1)
        && (PAIR_FOLLOWERS.test(nextById.text) || nextById.startsImperative)) {
        n.pairedWith = nextById.id; n.pairHow = 'adjacent';
        nextById.pairedWith = n.id; nextById.pairHow = 'adjacent';
        pairs.push({ negativeId: n.id, positiveId: nextById.id, how: 'adjacent' });
        continue;
      }
      // (d) semantic similarity against positives
      let best = null, bestScore = 0;
      for (const p of positives) {
        if (p.pairedWith != null && p.type !== 'must') continue;
        let score = jaccard(n.contentSet, p.contentSet);
        // verb-match boost only rescues pairs that already share some topic
        if (n.negatedVerb && p.mainVerb && stem(p.mainVerb) === n.negatedVerb && score > 0.12) score = Math.max(score, 0.55);
        if (n.section && p.section && n.section === p.section) score += 0.06;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (best && bestScore >= 0.24) {
        n.pairedWith = best.id; n.pairHow = 'similarity';
        if (best.pairedWith == null) best.pairedWith = n.id;
        pairs.push({ negativeId: n.id, positiveId: best.id, how: 'similarity', score: Math.round(bestScore * 100) / 100 });
      } else {
        unpaired.push(n);
      }
    }
    return { pairs, unpairedNegatives: unpaired };
  }

  // ------------------------------------------------------------------ conflicts & duplication

  function findConflicts(sentences) {
    const conflicts = [];
    const negatives = sentences.filter(s => s.type === 'negative');
    const affirmatives = sentences.filter(s => s.type === 'positive' || s.type === 'must');

    for (const n of negatives) {
      for (const a of affirmatives) {
        if (n.id === a.id) continue;
        // same negated verb affirmed elsewhere, or strong modal clash
        const verbClash = n.negatedVerb && a.mainVerb && stem(a.mainVerb) === n.negatedVerb;
        const topic = jaccard(n.contentSet, a.contentSet);
        const modalClash = (a.type === 'must' || a.mustMarkers.length > 0) && topic > 0.25;
        if ((verbClash && topic > 0.15) || topic > 0.5 || modalClash) {
          // avoid pairing noise: if they are already a "pair", it's a swap not a conflict
          if (n.pairedWith === a.id || a.pairedWith === n.id) continue;
          const dup = conflicts.find(c => (c.aId === a.id && c.bId === n.id) || (c.aId === n.id && c.bId === a.id));
          if (dup) continue;
          const severity = (verbClash || modalClash) ? 'high' : 'medium';
          conflicts.push({
            kind: verbClash ? 'verb-clash' : (modalClash ? 'modal-clash' : 'topic-clash'),
            severity,
            aId: a.id, bId: n.id,
            aLine: a.line, bLine: n.line,
            aText: a.text, bText: n.text,
            aType: a.type, bType: n.type,
            why: verbClash
              ? `"${a.mainVerb}" is affirmed in one instruction and negated in the other.`
              : modalClash
                ? 'A strong-modal instruction and a prohibition point at the same topic.'
                : 'Two instructions address the same topic with opposite polarity.'
          });
        }
      }
    }
    return conflicts;
  }

  function findDuplicates(sentences) {
    const groups = [];
    const used = new Set();
    const pool = sentences.filter(s => s.type !== 'neutral' && s.text.length > 25);
    for (let i = 0; i < pool.length; i++) {
      if (used.has(pool[i].id)) continue;
      const group = [pool[i]];
      for (let j = i + 1; j < pool.length; j++) {
        if (used.has(pool[j].id)) continue;
        if (jaccard(pool[i].contentSet, pool[j].contentSet) >= 0.62) {
          group.push(pool[j]);
          used.add(pool[j].id);
        }
      }
      if (group.length > 1) {
        used.add(pool[i].id);
        groups.push({ ids: group.map(g => g.id), lines: group.map(g => g.line), texts: group.map(g => g.text) });
      }
    }
    return groups;
  }

  // ------------------------------------------------------------------ attention

  function computeAttention(totalLines) {
    const N = Math.max(totalLines, 1);
    const tau = Math.max(6, N * 0.07);
    const base = 0.18, amp = 0.82;
    const scores = [];
    for (let i = 0; i < N; i++) {
      const v = base + amp * Math.exp(-i / tau) + amp * Math.exp(-(N - 1 - i) / tau);
      scores.push(Math.min(1, v / (base + amp + amp * Math.exp(-(N - 1) / tau))));
    }
    // zones
    const highStartEnd = Math.max(2, Math.min(12, Math.round(N * 0.12)));
    const highEndStart = N - Math.max(2, Math.min(12, Math.round(N * 0.12)));
    const deadThreshold = 0.38;
    let dzStart = 0, dzEnd = N - 1;
    for (let i = 0; i < N; i++) { if (scores[i] < deadThreshold) { dzStart = i; break; } }
    for (let i = N - 1; i >= 0; i--) { if (scores[i] < deadThreshold) { dzEnd = i; break; } }
    if (dzEnd <= dzStart) { dzStart = Math.floor(N / 2); dzEnd = Math.floor(N / 2); }
    return {
      scores, tau,
      highStartZone: { startLine: 1, endLine: highStartEnd },
      highEndZone: { startLine: highEndStart + 1, endLine: N },
      deadZone: { startLine: dzStart + 1, endLine: dzEnd + 1 },
      model: 'primacy/recency U-curve: attention(i) = base + amp·(e^(-i/τ) + e^(-(N-1-i)/τ)), τ ≈ ' + tau.toFixed(1) + ' lines'
    };
  }

  function findBuried(sentences, attention) {
    const buried = [];
    for (const s of sentences) {
      if (s.type === 'neutral') continue;
      const score = attention.scores[Math.min(Math.max(s.line - 1, 0), attention.scores.length - 1)];
      if (score < 0.32 && (s.type === 'must' || s.type === 'negative')) {
        buried.push({ id: s.id, line: s.line, text: s.text, type: s.type, attention: Math.round(score * 100) / 100 });
      }
    }
    buried.sort((a, b) => a.attention - b.attention);
    return buried;
  }

  // ------------------------------------------------------------------ description scorecard

  function scoreDescription(fm, fmError) {
    const data = fm && typeof fm === 'object' ? fm : {};
    const desc = String(data.description || '');
    const when = String(data.when_to_use || '');
    const text = desc + ' ' + when;
    const wordCount = words(desc).length;

    const checks = [];
    const push = (axis, score, ok, message, hint) => checks.push({ axis, score, ok, message, hint });

    // 1. Triggering
    let trig = 0;
    const hasUseWhen = /\buse (this|these|it|the|your)? ?(skill|plugin|mode)? ?(on|when|for|to|whenever)\b/i.test(text) || /\btriggers? on\b/i.test(text);
    const quotedPhrases = (text.match(/[“"]([^”"]{4,})[”"]/g) || []).length;
    const hasSkip = /\bskip (for|if|when|on|pure|ordinary|simple|standard|closed)\b/i.test(text) || /\bexcept\b|\bunless\b|\bnot for\b|\bdon'?t (use|invoke) (for|when|if)\b/i.test(text) || /\bnot (?:a|an) (?:small|minor|quick|simple|trivial|tiny|one-off|partial)\b/i.test(text);
    if (hasUseWhen) trig += 45;
    if (quotedPhrases >= 1) trig += 30;
    if (hasSkip) trig += 25;
    const trigMissing = [];
    if (!hasUseWhen) trigMissing.push('a "use when/for" clause');
    if (!quotedPhrases) trigMissing.push('quoted trigger phrases');
    if (!hasSkip) trigMissing.push('near-miss skip conditions');
    push('Triggering', Math.min(100, trig), trig >= 70,
      trigMissing.length ? 'Missing ' + trigMissing.join(', ') + '.' : 'Has use-when, quoted triggers and skip conditions.',
      'State when to use it, quote literal user phrasings, and add "Skip for X" near-miss branches.');

    // 2. Perspective
    const firstPerson = /\b(I|me|my|we|our|us)\b/.test(desc) || /\byou (can|should|will)\b/i.test(desc) || /^I (can|will|am)\b/.test(desc);
    push('Perspective', firstPerson ? 25 : 100, !firstPerson,
      firstPerson ? 'Description uses first/second person — breaks router discovery.' : 'Third person throughout.',
      'The description is injected into the system prompt — write it in third person.');

    // 3. Specificity
    let spec = 50;
    if (wordCount >= 15 && wordCount <= 100) spec = 100;
    else if (wordCount >= 10 && wordCount < 15) spec = 70;
    else if (wordCount > 100 && wordCount <= 130) spec = 65;
    else if (wordCount > 130) spec = 40;
    else if (wordCount < 10) spec = 30;
    push('Specificity', spec, spec >= 70,
      `${wordCount} words${wordCount < 15 ? ' — too thin to trigger reliably' : wordCount > 100 ? ' — over the ~100-word guidance' : ' — in range'}.`,
      'Aim for a specific ~100-word description: what it does + when to use it + trigger phrases.');

    // 4. Limits
    let lim = 100;
    if (desc.length > DESCRIPTION_CHAR_LIMIT) lim = 0;
    else if (desc.length + when.length > CC_LISTING_LIMIT) lim = 60;
    else if (desc.length > 900) lim = 80;
    push('Limits', lim, lim >= 80,
      `${desc.length} chars${when ? ` (+${when.length} when_to_use = ${desc.length + when.length})` : ''} vs ${DESCRIPTION_CHAR_LIMIT}-char API limit / ${CC_LISTING_LIMIT} CC listing.`,
      'Keep description under 1024 chars; combined with when_to_use under 1536 for Claude Code.');

    // 5. Schema
    let schema = 100;
    if (fmError) schema = 0;
    if (!data.name) schema -= 40;
    else {
      const n = String(data.name);
      if (n.length > NAME_MAX || !/^[a-z0-9-]+$/.test(n) || /anthropic|claude/.test(n)) schema -= 40;
    }
    push('Schema', Math.max(0, schema), schema >= 90,
      schema >= 90 ? 'name and frontmatter shape are valid.' : 'name or frontmatter shape has issues.',
      'name: lowercase-hyphens ≤64 chars, no reserved words; only known frontmatter keys.');

    // 6. Disambiguation
    let dis = 20;
    if (hasSkip) dis += 45;
    if (/\b(?:skip|not for|except|only)\b/i.test(text)) dis += 20;
    if (quotedPhrases >= 2) dis += 20;
    push('Disambiguation', Math.min(100, dis), dis >= 60,
      hasSkip ? 'Has skip/near-miss conditions.' : 'No near-miss disambiguation (what NOT to trigger on).',
      'Add "Skip for X" branches — near-miss disambiguation is the measurable differentiator of strong descriptions.');

    const issues = checks.filter(c => !c.ok);
    const overall = Math.round(checks.reduce((a, c) => a + c.score, 0) / checks.length);
    return { checks, issues, overall, desc, when, wordCount };
  }

  // ------------------------------------------------------------------ ideas

  function buildIdeas(r) {
    const ideas = [];
    const add = (severity, title, detail, lines, citation) => ideas.push({ severity, title, detail, lines: lines || [], citation });

    if (r.unpairedNegatives.length) {
      add('high', `${r.unpairedNegatives.length} prohibition${r.unpairedNegatives.length > 1 ? 's' : ''} without a positive counterpart`,
        'Negation drags the banned behavior into context and makes it more available ("don\'t think of an elephant"). Each prohibition should state the replacement behavior. Unpaired: ' +
        r.unpairedNegatives.slice(0, 6).map(n => `L${n.line} "${trunc(n.text, 60)}"`).join('; '),
        r.unpairedNegatives.map(n => n.line),
        'writing-for-agents SKILL.md:74 — prompt the positive');
    }
    if (r.conflicts.length) {
      for (const c of r.conflicts.slice(0, 5)) {
        add('high', c.kind === 'verb-clash' ? 'Contradictory instructions (verb clash)' : 'Possible conflicting instructions',
          `L${c.aLine}: ${trunc(c.aText, 70)} ↔ L${c.bLine}: ${trunc(c.bText, 70)} — ${c.why} Resolve to one rule, or scope each to its branch.`,
          [c.aLine, c.bLine], 'Anthropic best practices — consistent terminology');
      }
    }
    if (r.buried.length) {
      add('medium', `${r.buried.length} critical rule${r.buried.length > 1 ? 's' : ''} buried in the low-attention middle`,
        'First and last lines get outsized attention (primacy/recency). Critical MUSTs and prohibitions sitting in the dead zone are easy to miss. Buried: ' +
        r.buried.slice(0, 6).map(b => `L${b.line} "${trunc(b.text, 50)}"`).join('; ') +
        '. Consider restating them in the opening or closing lines — skill-creator deliberately repeats its core loop at the end "for emphasis".',
        r.buried.map(b => b.line),
        'skill-creator repeats core loop in final lines; corpus evidence of primacy/recency anchoring');
    }
    if (r.duplications.length) {
      add('medium', `${r.duplications.length} duplicated instruction group${r.duplications.length > 1 ? 's' : ''}`,
        'Same meaning in multiple places inflates token cost and drifts apart during edits. ' +
        r.duplications.slice(0, 3).map(d => `L${d.lines.join(',L')}`).join('; ') +
        ' — consolidate, or mark intentional restatement (primacy/recency emphasis is legitimate).',
        r.duplications.flatMap(d => d.lines),
        'writing-for-agents SKILL.md:78 — duplication inflates prominence and maintenance');
    }
    if (r.stats.bodyLines > BODY_LINE_BUDGET) {
      add('medium', `Body is ${r.stats.bodyLines} lines (budget ${BODY_LINE_BUDGET})`,
        'Split reference material into references/ files — SKILL.md should be a table of contents. Long bodies thin attention per line.',
        [], 'Anthropic best practices — keep SKILL.md under 500 lines');
    }
    if (r.stats.estTokens > BODY_TOKEN_BUDGET) {
      add('medium', `Body is ~${r.stats.estTokens} tokens (budget ${BODY_TOKEN_BUDGET})`,
        'Trim or move detail behind progressive disclosure. Estimated at words × 1.3.',
        [], 'Anthropic skills overview — body under 5k tokens');
    }
    if (r.stats.negDensityPer1k > CORPUS_NEG_DENSITY_BASELINE * 1.3) {
      add('low', `Negation density ${r.stats.negDensityPer1k}/1k words (corpus baseline ${CORPUS_NEG_DENSITY_BASELINE})`,
        'This skill leans on prohibitions more than ~283 surveyed skills. Consider converting some to positive statements.',
        [], 'corpus measurement');
    }
    if (r.stats.capsMustCount > 3) {
      add('low', `${r.stats.capsMustCount} ALL-CAPS emphasis words`,
        'If you find yourself writing ALWAYS or NEVER in all caps, that\'s a yellow flag — reframe and explain the reasoning instead.',
        [], 'skill-creator:302 — explain why instead of heavy-handed MUSTs');
    }
    if (r.description.issues.length) {
      for (const c of r.description.issues) {
        add(c.axis === 'Triggering' || c.axis === 'Perspective' ? 'high' : 'medium',
          `Description: ${c.axis} — ${c.message}`, c.hint, [], 'Anthropic best practices + skill-creator');
      }
    }
    if (r.frontmatter.issues.length) {
      for (const iss of r.frontmatter.issues) {
        add(iss.severity === 'high' ? 'high' : 'low', `Frontmatter: ${iss.message}`, iss.hint, [], 'Agent Skills spec');
      }
    }
    if (r.stats.codeBlocks === 0 && r.stats.bodyLines > 40) {
      add('low', 'No code examples in body',
        'Concrete input/output examples beat descriptions — add at least one fenced example.',
        [], 'Anthropic best practices — examples pattern');
    }
    const order = { high: 0, medium: 1, low: 2 };
    ideas.sort((a, b) => order[a.severity] - order[b.severity]);
    return ideas;
  }

  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ------------------------------------------------------------------ health

  function computeHealth(r) {
    const deductions = [];
    let score = 100;
    const ded = (points, reason) => { score -= points; deductions.push({ points, reason }); };
    if (r.conflicts.length) ded(Math.min(25, 8 * r.conflicts.length), `${r.conflicts.length} conflict(s)`);
    if (r.unpairedNegatives.length) ded(Math.min(20, 3 * r.unpairedNegatives.length), `${r.unpairedNegatives.length} unpaired prohibition(s)`);
    if (r.buried.length) ded(Math.min(10, 2 * r.buried.length), `${r.buried.length} buried critical rule(s)`);
    if (r.duplications.length) ded(Math.min(12, 4 * r.duplications.length), `${r.duplications.length} duplication group(s)`);
    if (r.stats.bodyLines > BODY_LINE_BUDGET) ded(10, `body ${r.stats.bodyLines} lines > ${BODY_LINE_BUDGET}`);
    if (r.stats.estTokens > BODY_TOKEN_BUDGET) ded(10, `~${r.stats.estTokens} tokens > ${BODY_TOKEN_BUDGET}`);
    if (r.frontmatter.issues.filter(i => i.severity === 'high').length) ded(8, 'high-severity frontmatter issues');
    const dIssues = r.description.issues.length;
    if (dIssues) ded(Math.min(15, 5 * dIssues), `${dIssues} description issue(s)`);
    if (r.stats.negDensityPer1k > CORPUS_NEG_DENSITY_BASELINE * 1.5) ded(5, 'negation density well above corpus baseline');
    score = Math.max(5, Math.min(100, Math.round(score)));
    const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
    return { score, grade, deductions };
  }

  // ------------------------------------------------------------------ line meta

  function buildLineMeta(raw, headerLines, blocks, sentences) {
    const lines = raw.split(/\r?\n/);
    const lineMeta = lines.map(() => ({ inCode: false, sectionIndex: -1, kinds: [], sentenceIds: [] }));
    for (const b of blocks) {
      const kind = b.kind === 'table_row' ? 'table' : b.kind;
      for (let i = Math.max(0, b.startLine - 1); i <= Math.min(lines.length - 1, b.endLine - 1); i++) {
        const lm = lineMeta[i];
        if (b.kind === 'code') lm.inCode = true;
        if (!lm.kinds.includes(kind)) lm.kinds.push(kind);
      }
    }
    for (const s of sentences) {
      const li = Math.min(lineMeta.length - 1, Math.max(0, s.line - 1));
      lineMeta[li].sentenceIds.push(s.id);
    }
    return lineMeta;
  }

  // ------------------------------------------------------------------ main

  function analyze(rawText, opts) {
    opts = opts || {};
    const md = opts.md || markdownit({ html: false, linkify: false, typographer: false });
    const raw = String(rawText);
    const fmSplit = splitFrontmatter(raw);
    const headerLines = fmSplit.headerLines;

    const { blocks, sections, codeBlocks, links } = parseStructure(md, fmSplit.body, headerLines);
    const sentences = extractSentences(blocks);
    for (const s of sentences) classifySentence(s);
    const { pairs, unpairedNegatives } = pairInstructions(sentences);
    const conflicts = findConflicts(sentences);
    const duplications = findDuplicates(sentences);

    const totalLines = raw.split(/\r?\n/).length;
    const bodyLines = Math.max(0, totalLines - headerLines);
    const attention = computeAttention(totalLines);
    const buried = findBuried(sentences, attention);

    const fmAudit = auditFrontmatter(fmSplit.fmData, fmSplit.fmError, headerLines);
    const description = scoreDescription(fmSplit.fmData, fmSplit.fmError);

    const bodyText = fmSplit.body;
    const wordCount = words(bodyText).length;
    const negMarkerCount = countMatches(bodyText, NEG_MARKER_RES);
    const capsMustCount = (bodyText.match(new RegExp(CAPS_WORD_RE.source, 'g')) || []).length;
    const positives = sentences.filter(s => s.type === 'positive');
    const negatives = sentences.filter(s => s.type === 'negative');
    const musts = sentences.filter(s => s.type === 'must');

    const stats = {
      totalLines,
      bodyLines,
      frontmatterLines: headerLines,
      words: wordCount,
      estTokens: Math.round(wordCount * 1.3),
      headings: sections.filter(s => s.level > 0).length,
      codeBlocks: codeBlocks.length,
      tables: blocks.filter(b => b.kind === 'table_row').length,
      lists: blocks.filter(b => b.kind === 'list_item').length,
      links: links.length,
      sentences: sentences.length,
      positiveCount: positives.length,
      negativeCount: negatives.length,
      mustCount: musts.length,
      pairedCount: pairs.length,
      unpairedCount: unpairedNegatives.length,
      conflictCount: conflicts.length,
      duplicationGroupCount: duplications.length,
      negDensityPer1k: wordCount ? Math.round((negMarkerCount / wordCount) * 1000 * 10) / 10 : 0,
      capsMustCount
    };

    const r = {
      ok: true,
      generatedAt: new Date().toISOString(),
      frontmatter: { raw: fmSplit.fmRaw, data: fmSplit.fmData || {}, error: fmSplit.fmError, issues: fmAudit.issues, unknownKeys: fmAudit.unknown, headerLines },
      meta: {
        name: fmSplit.fmData && fmSplit.fmData.name || null,
        description: fmSplit.fmData && fmSplit.fmData.description || null,
        whenToUse: fmSplit.fmData && fmSplit.fmData.when_to_use || null,
        allowedTools: fmSplit.fmData && fmSplit.fmData['allowed-tools'] || null,
        disableModelInvocation: !!(fmSplit.fmData && fmSplit.fmData['disable-model-invocation'])
      },
      stats,
      sections, sentences, pairs, unpairedNegatives, conflicts, duplications,
      attention, buried,
      description,
      codeBlocks, links
    };
    r.ideas = buildIdeas(r);
    r.health = computeHealth(r);
    r.lineMeta = buildLineMeta(raw, headerLines, blocks, sentences);
    r.llm = { applied: false, entries: [] };
    return r;
  }

  // ------------------------------------------------------------------ LLM overlay

  const LLM_SCHEMA = {
    unpaired_negatives: [{ line: 12, quote: '…', suggested_positive: 'Write: …' }],
    conflicts: [{ lines: [12, 40], a: '…', b: '…', why: '…' }],
    no_ops: [{ line: 8, quote: '…', why: 'model does this by default' }],
    duplication: [{ lines: [10, 55], quotes: ['…', '…'] }],
    strengths: ['…'],
    notes: 'overall assessment'
  };

  function llmPrompt(report) {
    const skillText = report.__raw || '';
    return [
      'You are auditing an LLM agent skill (SKILL.md) for instruction quality.',
      'Analyze the skill below and return STRICT JSON only (no prose, no code fence) with this shape:',
      JSON.stringify(LLM_SCHEMA, null, 2),
      '',
      'Rules:',
      '- unpaired_negatives: prohibitions with no positive replacement stated anywhere (give a concrete suggested_positive).',
      '- conflicts: pairs of instructions that genuinely contradict (include line numbers).',
      '- no_ops: instructions the model already does by default (padding).',
      '- duplication: same meaning stated in multiple places (different words, same instruction).',
      '- strengths: 2-4 short notes on what is already good.',
      '- Line numbers are 1-based file lines.',
      '',
      'SKILL.md:',
      '---8<---',
      skillText,
      '---8<---'
    ].join('\n');
  }

  function applyLlmOverlay(report, json, rawText) {
    const entries = [];
    const tryParse = typeof json === 'string' ? safeJsonParse(json) : json;
    if (!tryParse) return { ok: false, error: 'Could not parse JSON.', entries: [] };
    (tryParse.unpaired_negatives || []).forEach(e => {
      entries.push({ kind: 'unpaired_negative', severity: 'high', source: 'llm', line: e.line || null, quote: e.quote || '', suggested: e.suggested_positive || '', why: 'Prohibition without a positive counterpart (LLM judgment).' });
    });
    (tryParse.conflicts || []).forEach(e => {
      entries.push({ kind: 'conflict', severity: 'high', source: 'llm', lines: e.lines || [], quote: (e.a || '') + ' ↔ ' + (e.b || ''), why: e.why || 'Contradictory instructions.' });
    });
    (tryParse.no_ops || []).forEach(e => {
      entries.push({ kind: 'no_op', severity: 'medium', source: 'llm', line: e.line || null, quote: e.quote || '', why: e.why || 'Model does this by default.' });
    });
    (tryParse.duplication || []).forEach(e => {
      entries.push({ kind: 'duplication', severity: 'medium', source: 'llm', lines: e.lines || [], quote: (e.quotes || []).join(' ↔ '), why: 'Same meaning in multiple places.' });
    });
    report.llm = {
      applied: true,
      entries,
      strengths: tryParse.strengths || [],
      notes: tryParse.notes || ''
    };
    return { ok: true, entries };
  }

  function safeJsonParse(s) {
    s = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(s); } catch (e) {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) { return null; } }
      return null;
    }
  }

  return {
    analyze,
    llmPrompt,
    applyLlmOverlay,
    constants: {
      BODY_LINE_BUDGET, BODY_TOKEN_BUDGET, DESCRIPTION_CHAR_LIMIT, CC_LISTING_LIMIT,
      CORPUS_NEG_DENSITY_BASELINE, NAME_MAX, SPEC_KEYS, CC_EXT_KEYS
    }
  };
});
