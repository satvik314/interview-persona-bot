import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { generateJSON } from './gemini.js';

const STATS_KEY = 'aia.quizStats';
const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const COUNTS = [5, 10, 15];
const MIXED = 'Mixed';
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

const QUIZ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          topic: { type: 'STRING' },
          question: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          answerIndex: { type: 'INTEGER' },
          explanation: { type: 'STRING' },
        },
        required: ['topic', 'question', 'options', 'answerIndex', 'explanation'],
      },
    },
  },
  required: ['questions'],
};

const inline = (text) => DOMPurify.sanitize(marked.parseInline(String(text ?? '')));
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Validate model output and shuffle options so the correct answer isn't always in the same slot. */
function normalizeQuestions(raw, count) {
  const list = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const q of list) {
    const options = Array.isArray(q?.options) ? q.options.map((o) => String(o).trim()) : [];
    const answer = Number(q?.answerIndex);
    if (!q?.question || options.length < 2 || options.length > 5) continue;
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
    if (new Set(options).size !== options.length) continue;

    const order = shuffle(options.map((_, i) => i));
    out.push({
      topic: String(q.topic || '').trim(),
      question: String(q.question).trim(),
      options: order.map((i) => options[i]),
      answerIndex: order.indexOf(answer),
      explanation: String(q.explanation || '').trim(),
    });
    if (out.length === count) break;
  }
  return out;
}

function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY)) || {};
  } catch {
    return {};
  }
}

function recordResult(roleId, correct, total) {
  const stats = loadStats();
  const pct = Math.round((correct / total) * 100);
  const s = stats[roleId] || { taken: 0, best: 0 };
  stats[roleId] = { taken: s.taken + 1, best: Math.max(s.best, pct), last: pct };
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}

function verdict(pct) {
  if (pct === 100) return 'Flawless. You are interview-ready on this topic.';
  if (pct >= 80) return 'Strong result. Polish the few gaps below and you are set.';
  if (pct >= 60) return 'Solid base. Review the explanations for the ones you missed.';
  if (pct >= 40) return 'Getting there. Ask the coach to walk you through the misses.';
  return 'Good that you found these gaps now and not in the interview. Let’s work on them.';
}

/**
 * Quiz view: one quiz per role, rendered into `root`.
 * @param {object} deps
 * @param {HTMLElement} deps.root
 * @param {() => object} deps.getRole      Returns the active role.
 * @param {() => string} deps.getApiKey
 * @param {(msg: string) => void} deps.onNeedKey
 * @param {(prompt: string) => void} deps.onDiscuss  Send a follow-up to the chat coach.
 */
export function createQuizView({ root, getRole, getApiKey, onNeedKey, onDiscuss }) {
  /** @type {Record<string, any>} */
  const quizzes = {};
  /** @type {Record<string, string[]>} recently asked question stems per role, to avoid repeats */
  const asked = {};

  const quizFor = (roleId) =>
    (quizzes[roleId] ??= {
      phase: 'setup',
      config: { topic: MIXED, difficulty: 'Medium', count: 5 },
      questions: [],
      answers: [],
      index: 0,
      error: '',
      controller: null,
    });

  const current = () => quizFor(getRole().id);

  // ---------- Generation ----------
  async function start() {
    const apiKey = getApiKey();
    if (!apiKey) {
      onNeedKey('Add your Gemini API key to generate a quiz.');
      return;
    }
    const role = getRole();
    const quiz = quizFor(role.id);
    const { topic, difficulty, count } = quiz.config;

    quiz.controller?.abort();
    const controller = new AbortController();
    Object.assign(quiz, { phase: 'loading', error: '', controller });
    render();

    const topicLine =
      topic === MIXED
        ? `Cover a mix of these areas: ${role.quizTopics.join(', ')}.`
        : `Focus every question on: ${topic}.`;
    const avoid = (asked[role.id] || []).slice(-25);

    const prompt = `Write a ${difficulty.toLowerCase()} multiple-choice quiz of exactly ${count} questions to help a candidate prepare for ${role.title} interviews.

${topicLine}

Rules:
- Each question has exactly 4 options and exactly one correct answer (answerIndex is 0-based).
- Make distractors plausible: common misconceptions, not obviously wrong jokes.
- Mix conceptual questions with realistic scenario questions like the ones asked in real ${role.title} interview loops.
- Difficulty "${difficulty}": ${
      difficulty === 'Easy'
        ? 'core concepts every candidate should know.'
        : difficulty === 'Medium'
          ? 'applied understanding and tradeoffs.'
          : 'nuanced tradeoffs, edge cases and senior-level judgment.'
    }
- "explanation": 2-3 sentences on why the answer is correct and why the most tempting wrong option is wrong. Do not refer to options by letter.
- "topic": a short 2-4 word label for the question's area.
- Keep questions concise. Use backticks for code or formulas. Do not put the answer in the question.${
      avoid.length ? `\n- Do not repeat these recently asked questions:\n${avoid.map((q) => `  - ${q}`).join('\n')}` : ''
    }`;

    try {
      const raw = await generateJSON({
        apiKey,
        system: `You are an expert interviewer who writes accurate, high-quality practice quizzes for ${role.title} candidates. Accuracy matters more than anything: if unsure about a fact, write a different question.`,
        prompt,
        schema: QUIZ_SCHEMA,
        signal: controller.signal,
      });
      const questions = normalizeQuestions(raw, count);
      if (!questions.length) throw new Error('Gemini did not return any usable questions. Please try again.');

      asked[role.id] = [...(asked[role.id] || []), ...questions.map((q) => q.question.slice(0, 140))].slice(-40);
      Object.assign(quiz, {
        phase: 'playing',
        questions,
        answers: new Array(questions.length).fill(null),
        index: 0,
        controller: null,
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      Object.assign(quiz, { phase: 'error', error: err.message, controller: null });
      if ([400, 401, 403].includes(err.status) && /key/i.test(err.message)) onNeedKey(err.message);
    }
    if (getRole().id === role.id) render();
  }

  // ---------- Actions ----------
  function answer(i) {
    const quiz = current();
    if (quiz.phase !== 'playing' || quiz.answers[quiz.index] !== null) return;
    if (i < 0 || i >= quiz.questions[quiz.index].options.length) return;
    quiz.answers[quiz.index] = i;
    render();
  }

  function next() {
    const quiz = current();
    if (quiz.phase !== 'playing' || quiz.answers[quiz.index] === null) return;
    if (quiz.index < quiz.questions.length - 1) {
      quiz.index++;
    } else {
      quiz.phase = 'results';
      recordResult(getRole().id, score(quiz), quiz.questions.length);
    }
    render();
  }

  const score = (quiz) => quiz.answers.filter((a, i) => a === quiz.questions[i].answerIndex).length;

  function discussMistakes() {
    const quiz = current();
    const missed = quiz.questions
      .map((q, i) => ({ q, a: quiz.answers[i] }))
      .filter(({ q, a }) => a !== q.answerIndex);
    const { topic, difficulty } = quiz.config;
    const lines = missed.map(
      ({ q, a }, n) =>
        `${n + 1}. ${q.question}\n   - My answer: ${q.options[a]}\n   - Correct answer: ${q.options[q.answerIndex]}`,
    );
    onDiscuss(
      `I just took a ${difficulty.toLowerCase()} quiz on "${topic}" and scored ${score(quiz)}/${quiz.questions.length}. These are the ones I got wrong:\n\n${lines.join(
        '\n',
      )}\n\nHelp me understand the concepts I'm missing, explain how each would come up in a real interview, and give me a memorable way to remember each one.`,
    );
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const quiz = current();
    const { action, value } = el.dataset;
    switch (action) {
      case 'topic':
        quiz.config.topic = value;
        render();
        break;
      case 'difficulty':
        quiz.config.difficulty = value;
        render();
        break;
      case 'count':
        quiz.config.count = Number(value);
        render();
        break;
      case 'start':
        start();
        break;
      case 'cancel':
        quiz.controller?.abort();
        Object.assign(quiz, { phase: 'setup', controller: null });
        render();
        break;
      case 'answer':
        answer(Number(value));
        break;
      case 'next':
        next();
        break;
      case 'quit':
      case 'setup':
        quiz.phase = 'setup';
        render();
        break;
      case 'retake':
        Object.assign(quiz, {
          phase: 'playing',
          index: 0,
          answers: new Array(quiz.questions.length).fill(null),
          questions: quiz.questions.map((q) => {
            const order = shuffle(q.options.map((_, i) => i));
            return { ...q, options: order.map((i) => q.options[i]), answerIndex: order.indexOf(q.answerIndex) };
          }),
        });
        render();
        break;
      case 'discuss':
        discussMistakes();
        break;
    }
  });

  /** Keyboard shortcuts while a quiz is open: 1-4 / A-D to answer, Enter to continue. */
  function handleKey(e) {
    const quiz = current();
    if (quiz.phase !== 'playing' || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.target.closest?.('input, textarea')) return false;
    const key = e.key.toUpperCase();
    const letter = LETTERS.indexOf(key);
    const digit = /^[1-5]$/.test(key) ? Number(key) - 1 : -1;
    if (letter !== -1 || digit !== -1) {
      answer(letter !== -1 ? letter : digit);
      return true;
    }
    if (e.key === 'Enter' && quiz.answers[quiz.index] !== null) {
      e.preventDefault();
      next();
      return true;
    }
    return false;
  }

  // ---------- Rendering ----------
  const pill = (action, value, label, active) =>
    `<button type="button" class="opt-pill${active ? ' active' : ''}" data-action="${action}" data-value="${escapeHtml(
      value,
    )}" aria-pressed="${active}">${escapeHtml(label)}</button>`;

  function renderSetup(role, quiz) {
    const stats = loadStats()[role.id];
    const { topic, difficulty, count } = quiz.config;
    return `
      <div class="quiz-setup">
        <div class="quiz-hero">
          <div class="quiz-badge" aria-hidden="true">?</div>
          <div>
            <h2>${escapeHtml(role.title)} quiz</h2>
            <p>Multiple-choice questions written by Gemini for this role, with an explanation after every answer.</p>
          </div>
          ${
            stats
              ? `<div class="quiz-stats"><span><b>${stats.taken}</b> taken</span><span><b>${stats.best}%</b> best</span></div>`
              : ''
          }
        </div>

        <div class="quiz-field">
          <span class="quiz-label">Topic</span>
          <div class="opt-group">
            ${[MIXED, ...role.quizTopics].map((t) => pill('topic', t, t, t === topic)).join('')}
          </div>
        </div>
        <div class="quiz-row">
          <div class="quiz-field">
            <span class="quiz-label">Difficulty</span>
            <div class="opt-group">${DIFFICULTIES.map((d) => pill('difficulty', d, d, d === difficulty)).join('')}</div>
          </div>
          <div class="quiz-field">
            <span class="quiz-label">Questions</span>
            <div class="opt-group">${COUNTS.map((c) => pill('count', c, c, c === count)).join('')}</div>
          </div>
        </div>

        <button type="button" class="primary-btn big" data-action="start">Generate quiz →</button>
      </div>`;
  }

  function renderLoading(quiz) {
    const { topic, difficulty, count } = quiz.config;
    return `
      <div class="quiz-center">
        <div class="spinner" aria-hidden="true"></div>
        <p class="quiz-loading-title">Writing your quiz…</p>
        <p class="muted">${count} ${difficulty.toLowerCase()} questions · ${escapeHtml(topic)}</p>
        <button type="button" class="ghost-btn" data-action="cancel">Cancel</button>
      </div>`;
  }

  function renderError(quiz) {
    return `
      <div class="quiz-center">
        <div class="quiz-error">⚠️ ${escapeHtml(quiz.error)}</div>
        <div class="quiz-actions">
          <button type="button" class="ghost-btn" data-action="setup">Back</button>
          <button type="button" class="primary-btn" data-action="start">Try again</button>
        </div>
      </div>`;
  }

  function renderPlaying(quiz) {
    const q = quiz.questions[quiz.index];
    const picked = quiz.answers[quiz.index];
    const answered = picked !== null;
    const total = quiz.questions.length;
    const progress = ((quiz.index + (answered ? 1 : 0)) / total) * 100;
    const isLast = quiz.index === total - 1;
    const correct = picked === q.answerIndex;

    const options = q.options
      .map((opt, i) => {
        let cls = 'q-option';
        if (answered) {
          if (i === q.answerIndex) cls += ' is-correct';
          else if (i === picked) cls += ' is-wrong';
          else cls += ' is-dim';
        }
        return `<button type="button" class="${cls}" data-action="answer" data-value="${i}" ${answered ? 'disabled' : ''}>
            <span class="q-key">${LETTERS[i]}</span><span class="q-option-text">${inline(opt)}</span>
            ${answered && i === q.answerIndex ? '<span class="q-mark">✓</span>' : ''}
            ${answered && i === picked && !correct ? '<span class="q-mark">✗</span>' : ''}
          </button>`;
      })
      .join('');

    return `
      <div class="quiz-play">
        <div class="quiz-topbar">
          <span class="quiz-count">Question <b>${quiz.index + 1}</b> / ${total}</span>
          <span class="quiz-score">Score <b>${score(quiz)}</b></span>
          <button type="button" class="ghost-btn small" data-action="quit">End quiz</button>
        </div>
        <div class="quiz-bar"><i style="width:${progress}%"></i></div>

        <div class="quiz-card">
          ${q.topic ? `<span class="q-topic">${escapeHtml(q.topic)}</span>` : ''}
          <h3 class="q-text">${inline(q.question)}</h3>
          <div class="q-options">${options}</div>

          ${
            answered
              ? `<div class="q-explain ${correct ? 'good' : 'bad'}">
                  <strong>${correct ? 'Correct!' : 'Not quite.'}</strong> ${inline(q.explanation)}
                </div>
                <div class="quiz-actions end">
                  <button type="button" class="primary-btn" data-action="next">${isLast ? 'See results' : 'Next question'} →</button>
                </div>`
              : '<p class="quiz-hint">Pick an answer (or press A–D)</p>'
          }
        </div>
      </div>`;
  }

  function renderResults(quiz) {
    const total = quiz.questions.length;
    const s = score(quiz);
    const pct = Math.round((s / total) * 100);
    const missed = total - s;

    const review = quiz.questions
      .map((q, i) => {
        const ok = quiz.answers[i] === q.answerIndex;
        return `
          <details class="review-item ${ok ? 'good' : 'bad'}" ${ok ? '' : 'open'}>
            <summary><span class="review-mark">${ok ? '✓' : '✗'}</span><span>${inline(q.question)}</span></summary>
            <div class="review-body">
              ${ok ? '' : `<p><span class="muted">Your answer:</span> ${inline(q.options[quiz.answers[i]])}</p>`}
              <p><span class="muted">Correct answer:</span> ${inline(q.options[q.answerIndex])}</p>
              <p>${inline(q.explanation)}</p>
            </div>
          </details>`;
      })
      .join('');

    return `
      <div class="quiz-results">
        <div class="result-hero">
          <div class="score-ring" style="--pct:${pct}">
            <div><b>${s}</b><span>/ ${total}</span></div>
          </div>
          <div>
            <h2>${pct}%</h2>
            <p>${verdict(pct)}</p>
            <div class="quiz-actions">
              ${missed ? '<button type="button" class="primary-btn" data-action="discuss">Discuss my mistakes with the coach</button>' : ''}
              <button type="button" class="${missed ? 'ghost-btn' : 'primary-btn'}" data-action="setup">New quiz</button>
              <button type="button" class="ghost-btn" data-action="retake">Retake</button>
            </div>
          </div>
        </div>
        <h3 class="review-title">Review</h3>
        <div class="review-list">${review}</div>
      </div>`;
  }

  function render() {
    const role = getRole();
    const quiz = quizFor(role.id);
    const html = {
      setup: () => renderSetup(role, quiz),
      loading: () => renderLoading(quiz),
      error: () => renderError(quiz),
      playing: () => renderPlaying(quiz),
      results: () => renderResults(quiz),
    }[quiz.phase]();
    const prevPhase = root.dataset.phase;
    const prevIndex = root.dataset.index;
    root.innerHTML = html;
    root.dataset.phase = quiz.phase;
    root.dataset.index = String(quiz.index);
    // Scroll to top whenever the screen (or question) changes, but not when just selecting an answer.
    if (prevPhase !== quiz.phase || prevIndex !== String(quiz.index)) root.scrollTop = 0;
    else if (quiz.phase === 'playing') root.querySelector('.quiz-actions.end')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  return { render, handleKey };
}
