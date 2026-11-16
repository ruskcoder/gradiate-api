/**
 * Generated grades for the demo account (Test User / testuser).
 *
 * Six grading periods of six weeks starting mid-August of the current school
 * year. Periods that have started get 14 assignments per class (2 Major,
 * 4 Minor, 8 Other; weighted 60/30/10 like Katy ISD HAC); periods that haven't
 * started come back empty, as HAC does. Everything is seeded per term + class,
 * so the same request always returns the same grades.
 *
 * Within each started period, class averages span green (90+), blue (80s) and
 * yellow (70s), and every class's 8 most recent assignments include all four
 * colours (green, blue, yellow, red).
 */

const CLASSES = [
  { name: 'ENGLISH 2 A', course: '0112A - 2', period: '1', teacher: 'Parker, Emily', room: '1204' },
  { name: 'GEOMETRY A', course: '0222A - 4', period: '2', teacher: 'Nguyen, David', room: '2110' },
  { name: 'CHEMISTRY A', course: '0313A - 1', period: '3', teacher: 'Reyes, Maria', room: '3015' },
  { name: 'WORLD HISTORY A', course: '0421A - 3', period: '4', teacher: 'Collins, James', room: '1132' },
  { name: 'SPANISH 2 A', course: '0532A - 1', period: '5', teacher: 'Morales, Sofia', room: '1240' },
  { name: 'COMP SCI 1 A', course: '2010A - 2', period: '6', teacher: 'Patel, Ryan', room: '2205' },
  { name: 'HEALTH A', course: '0845A - 1', period: '7', teacher: 'Brooks, Kelly', room: '0410' },
];

const NAMES = {
  'ENGLISH 2 A': {
    Major: ['Essay: Of Mice and Men', 'Unit Test: Rhetoric', 'Argumentative Essay', 'Poetry Analysis Test'],
    Minor: ['Vocab Quiz 1', 'Vocab Quiz 2', 'Reading Check', 'Annotation Quiz', 'Grammar Quiz', 'Socratic Seminar'],
    Other: ['Journal Entry', 'Warm-up', 'Reading Log', 'Peer Review', 'Exit Ticket', 'Homework: Ch. 3', 'Discussion Post', 'Outline'],
  },
  'GEOMETRY A': {
    Major: ['Test: Proofs', 'Test: Triangles', 'Test: Similarity', 'Project: Tessellations'],
    Minor: ['Quiz: Angles', 'Quiz: Congruence', 'Quiz: Parallel Lines', 'Quiz: Midsegments', 'Quiz: Area', 'Quiz: Circles'],
    Other: ['HW 2.1', 'HW 2.2', 'HW 2.3', 'Warm-up', 'Classwork', 'Exit Ticket', 'Khan: Transformations', 'Notes Check'],
  },
  'CHEMISTRY A': {
    Major: ['Test: Atomic Structure', 'Test: Periodic Table', 'Lab Report: Density', 'Test: Bonding'],
    Minor: ['Quiz: Isotopes', 'Lab: Flame Test', 'Quiz: Electron Config', 'Quiz: Naming', 'Lab: Reactions', 'Quiz: Moles'],
    Other: ['Lab Safety', 'Worksheet', 'Warm-up', 'POGIL', 'Exit Ticket', 'Homework', 'Notes Check', 'Lab Prelab'],
  },
  'WORLD HISTORY A': {
    Major: ['Test: Ancient Civs', 'DBQ Essay', 'Test: Middle Ages', 'Project: Trade Routes'],
    Minor: ['Map Quiz', 'Quiz: Rome', 'Quiz: Feudalism', 'Quiz: Renaissance', 'Primary Source Quiz', 'Vocab Quiz'],
    Other: ['Reading Guide', 'Warm-up', 'Timeline', 'Exit Ticket', 'Gallery Walk', 'Notes', 'Video Questions', 'Graphic Organizer'],
  },
  'SPANISH 2 A': {
    Major: ['Examen: Unidad 1', 'Presentacion Oral', 'Examen: Unidad 2', 'Proyecto: Mi Familia'],
    Minor: ['Quiz: Preterito', 'Quiz: Vocabulario', 'Escucha', 'Quiz: Ser vs Estar', 'Lectura', 'Quiz: Imperfecto'],
    Other: ['Tarea 1', 'Tarea 2', 'Calentamiento', 'Diario', 'Practica', 'Conversacion', 'Quizlet', 'Boleto de Salida'],
  },
  'COMP SCI 1 A': {
    Major: ['Project: Calculator', 'Test: Loops', 'Project: Text Game', 'Test: Arrays'],
    Minor: ['Quiz: Variables', 'Lab: Conditionals', 'Quiz: Loops', 'Lab: Methods', 'Quiz: Strings', 'Lab: Debugging'],
    Other: ['CodingBat 1', 'CodingBat 2', 'Warm-up', 'Exit Ticket', 'Classwork', 'Pseudocode', 'Practice-It', 'Notes Check'],
  },
  'HEALTH A': {
    Major: ['Test: Nutrition', 'Project: Wellness Plan', 'Test: Body Systems', 'Presentation'],
    Minor: ['Quiz: Food Groups', 'Quiz: Fitness', 'Quiz: Mental Health', 'Case Study', 'Quiz: First Aid', 'Reflection'],
    Other: ['Food Log', 'Warm-up', 'Article Response', 'Exit Ticket', 'Worksheet', 'Notes', 'Video Response', 'Goal Setting'],
  },
};

const WEIGHTS = { Major: 60, Minor: 30, Other: 10 };
const TERMS = ['1', '2', '3', '4', '5', '6'];
const TERM_DAYS = 42;
const DAY = 86400000;

// Mid-band target per colour: green, blue, yellow.
const TARGETS = { g: [92, 99], b: [82, 88], y: [72, 78] };
// Per-term colour pattern for the 7 classes, rotated each term.
const PATTERN = ['g', 'b', 'g', 'y', 'g', 'b', 'y'];

function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r, lo, hi) => Math.round(lo + r() * (hi - lo));
const fmt = (n) => (n >= 100 ? n.toFixed(1) : n.toFixed(2));
const mdY = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

function schoolYearStart(now) {
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const d = new Date(year, 7, 10); // second-ish Monday of August
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

function termRange(term, now) {
  const start = new Date(schoolYearStart(now).getTime() + (Number(term) - 1) * TERM_DAYS * DAY);
  const end = new Date(start.getTime() + (TERM_DAYS - 3) * DAY);
  return { start, end };
}

function currentTerm(now) {
  for (let i = TERMS.length - 1; i >= 0; i -= 1) {
    if (termRange(TERMS[i], now).start <= now) return TERMS[i];
  }
  return TERMS[0];
}

function average(scores) {
  const by = { Major: [], Minor: [], Other: [] };
  for (const s of scores) by[s.category].push(s.value);
  let total = 0;
  for (const [cat, vals] of Object.entries(by)) total += (vals.reduce((a, b) => a + b, 0) / vals.length) * WEIGHTS[cat] / 100;
  return total;
}

function bandOf(n) {
  if (n >= 90) return 'g';
  if (n >= 80) return 'b';
  if (n >= 70) return 'y';
  return 'r';
}

/**
 * One class's assignments for a term, newest first. The latest 8 are
 * 1 Major + 2 Minor + 5 Other and contain one score of each colour; the older 6
 * (1 Major + 2 Minor + 3 Other) are solved so the average lands in `band`.
 */
function buildScores(cls, term, band, range, now) {
  const end = range.end < now ? range.end : now;
  const span = Math.max(1, Math.round((end - range.start) / DAY));
  const names = NAMES[cls.name];
  const termIdx = Number(term) - 1;
  const pick = (cat, i) => names[cat][(i + termIdx) % names[cat].length];

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const r = rng(`${term}|${cls.name}|${attempt}`);
    const [lo, hi] = TARGETS[band];
    const target = between(r, lo, hi);

    // Latest 8: one forced score per colour, the rest near the target.
    const latestCats = ['Major', 'Minor', 'Minor', 'Other', 'Other', 'Other', 'Other', 'Other'];
    const forced = [between(r, 92, 100), between(r, 81, 88), between(r, 71, 78), between(r, 55, 68)];
    const slots = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => r() - 0.5).slice(0, 4);
    const latest = latestCats.map((category, i) => {
      const f = slots.indexOf(i);
      let value = f !== -1 ? forced[f] : between(r, target - 5, Math.min(100, target + 8));
      if (f === -1 && category === 'Other' && r() < 0.5) value = 100;
      return { category, value };
    });
    // Occasional extra credit on a non-forced green Major.
    if (band === 'g' && !slots.includes(0) && r() < 0.5) latest[0].value = between(r, 101, 105);

    const older = [
      { category: 'Minor', value: between(r, target - 6, Math.min(100, target + 6)) },
      { category: 'Minor', value: between(r, target - 6, Math.min(100, target + 6)) },
      { category: 'Other', value: 100 },
      { category: 'Other', value: between(r, target - 4, 100) },
      { category: 'Other', value: between(r, target - 4, 100) },
    ];
    // Solve the older Major for the target.
    const minors = [latest[1], latest[2], older[0], older[1]].map((s) => s.value);
    const others = [...latest.slice(3), ...older.slice(2)].map((s) => s.value);
    const minAvg = minors.reduce((a, b) => a + b, 0) / minors.length;
    const othAvg = others.reduce((a, b) => a + b, 0) / others.length;
    const majorNeeded = Math.round(2 * ((target - 0.3 * minAvg - 0.1 * othAvg) / 0.6) - latest[0].value);
    if (majorNeeded < 55 || majorNeeded > 100) continue;
    const ordered = [...latest, { category: 'Major', value: majorNeeded }, ...older];
    const avg = average(ordered);
    if (bandOf(avg) !== band) continue;

    // Dates: newest first, spread across the elapsed part of the term (weekdays).
    const counters = { Major: 0, Minor: 0, Other: 0 };
    const scores = ordered.map((s, i) => {
      const d = new Date(end.getTime() - Math.round((i / 13) * span) * DAY);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
      if (d < range.start) d.setTime(range.start.getTime());
      const name = pick(s.category, counters[s.category]++);
      return {
        dateDue: mdY(d),
        dateAssigned: mdY(d),
        name,
        category: s.category,
        score: fmt(s.value),
        totalPoints: '100.00',
        weight: '1.00',
        weightedScore: s.value.toFixed(2),
        weightedTotalPoints: '100.0000',
        percentage: `${s.value.toFixed(2)}%`,
        badges: [],
      };
    });
    return { scores, avg, values: ordered };
  }
  throw new Error(`demo: could not build ${cls.name} for term ${term}`);
}

function categories(values) {
  const out = {};
  for (const cat of ['Major', 'Minor', 'Other']) {
    const vals = values.filter((v) => v.category === cat).map((v) => v.value);
    const pts = vals.reduce((a, b) => a + b, 0);
    const max = vals.length * 100;
    const pct = (pts / max) * 100;
    out[cat] = {
      studentsPoints: pts.toFixed(4),
      maximumPoints: max.toFixed(2),
      percent: `${pct.toFixed(3)}%`,
      categoryWeight: WEIGHTS[cat].toFixed(2),
      categoryPoints: ((pct * WEIGHTS[cat]) / 100).toFixed(6),
    };
  }
  return out;
}

function buildClasses(requestedTerm, now = new Date()) {
  const current = currentTerm(now);
  const term = TERMS.includes(String(requestedTerm)) ? String(requestedTerm) : current;
  const range = termRange(term, now);
  const started = range.start <= now;
  const shift = Number(term) - 1;

  const classes = CLASSES.map((cls, i) => {
    const base = { ...cls, average: '', scores: [], categories: {} };
    if (!started) return base;
    const band = PATTERN[(i + shift) % PATTERN.length];
    const { scores, avg, values } = buildScores(cls, term, band, range, now);
    return { ...base, average: fmt(Math.round(avg * 100) / 100), scores, categories: categories(values) };
  });

  return { scoresIncluded: true, termList: TERMS, term, classes };
}

export { buildClasses };
