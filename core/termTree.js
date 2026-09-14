/**
 * Data-driven term/subterm hierarchy.
 *
 * Portals expose a flat, chronologically-ordered list of grading columns
 * (P1 C1 P2 C2 … / PR1 PR2 1ST … SM1 …). Those columns actually cascade —
 * a progress period rolls into a cycle, a cycle into a semester, a semester
 * into the year — to arbitrary depth. This module reconstructs that cascade
 * from the data alone (no hard-coded term names) and returns it as a nested
 * forest the UI can render as as many levels of subtabs as exist:
 *
 *   node   = { label, children: [ node, … ] }   // children: [] for a leaf
 *   forest = [ node, … ]                         // roots = the COARSEST level
 *
 * Two signals are supported, matching what each portal makes available:
 *   - nestByContainment: exact begin/end dates per column (PowerSchool) — a
 *     column is a child of the tightest-fitting column whose date range strictly
 *     contains it. Fully exact, any depth.
 *   - nestByFrequency:  ordering only, no dates (Skyward) — a column's grain is
 *     inferred from how often its label-family recurs across the year (finer
 *     buckets recur more), and a coarser summary column adopts the run of finer
 *     columns immediately preceding it. Any depth.
 */

/** A tree node. */
function node(label, children = []) {
  return { label, children };
}

/** True if any node in the forest has children (i.e. real subterms exist). */
function forestHasChildren(forest) {
  return forest.some((n) => n.children && n.children.length > 0);
}

/** Pre-order flatten to the ordered flat label list. */
function flattenForest(forest) {
  const out = [];
  const walk = (n) => {
    out.push(n.label);
    (n.children || []).forEach(walk);
  };
  forest.forEach(walk);
  return out;
}

/** Root→node label path for a given label, or [] if not found. */
function pathToLabel(forest, label) {
  const find = (n, trail) => {
    const next = [...trail, n.label];
    if (n.label === label) return next;
    for (const c of n.children || []) {
      const r = find(c, next);
      if (r) return r;
    }
    return null;
  };
  for (const r of forest) {
    const p = find(r, []);
    if (p) return p;
  }
  return [];
}

/**
 * Build the forest from date ranges (PowerSchool).
 * @param labels   ordered term labels
 * @param rangeOf  label -> { beg: Date, end: Date } | null
 * A label with no usable range is emitted as a root leaf in its original order.
 */
function nestByContainment(labels, rangeOf) {
  const info = labels.map((label) => {
    const r = rangeOf(label);
    const ok = r && r.beg instanceof Date && r.end instanceof Date &&
      !isNaN(r.beg) && !isNaN(r.end);
    return {
      label,
      beg: ok ? r.beg.getTime() : null,
      end: ok ? r.end.getTime() : null,
      span: ok ? r.end.getTime() - r.beg.getTime() : null,
    };
  });

  // A "full-year" column (Y1) spans essentially the whole calendar and is a
  // parallel *summary* of the year, not a container in the tab hierarchy: a
  // semester (S1/S2) is date-wise ⊂ the year, but the UI wants S1, S2 and Y1 as
  // sibling top tabs — not S1/S2 buried under Y1. So a column covering ~the full
  // extent of every dated column is forced to be a root and is never anyone's
  // parent; the semesters (which it would otherwise have swallowed) then surface
  // as roots themselves, with the finer columns cascading beneath each semester.
  const dated = info.filter((x) => x.span != null);
  let globalBeg = Infinity, globalEnd = -Infinity;
  for (const x of dated) { globalBeg = Math.min(globalBeg, x.beg); globalEnd = Math.max(globalEnd, x.end); }
  const globalSpan = globalEnd - globalBeg;
  const FULL_YEAR_FRAC = 0.85;
  const isFullYear = (x) =>
    x.span != null && globalSpan > 0 && x.span >= FULL_YEAR_FRAC * globalSpan;

  // X ⊂ Y iff Y encloses X's range and is strictly wider. Parent = the tightest
  // (smallest-span) such Y; ties broken toward the later start / earlier end.
  const parentOf = info.map((x, i) => {
    if (x.span == null) return -1;
    if (isFullYear(x)) return -1; // year summary is always a top-level root
    let best = -1;
    for (let j = 0; j < info.length; j++) {
      if (j === i) continue;
      const y = info[j];
      if (y.span == null) continue;
      if (isFullYear(y)) continue; // never nest under the year summary
      const encloses = y.beg <= x.beg && x.end <= y.end && y.span > x.span;
      if (!encloses) continue;
      if (best === -1 || y.span < info[best].span ||
        (y.span === info[best].span && y.beg > info[best].beg)) {
        best = j;
      }
    }
    return best;
  });

  const nodes = info.map((x) => node(x.label));
  const roots = [];
  info.forEach((x, i) => {
    const p = parentOf[i];
    if (p === -1) roots.push(nodes[i]);
    else nodes[p].children.push(nodes[i]);
  });

  const byBeg = (a, b) => {
    const ai = labels.indexOf(a.label), bi = labels.indexOf(b.label);
    const ra = info[ai], rb = info[bi];
    // The year summary sorts after the semester/period partition it summarizes,
    // so it reads as the last top tab (…S1, S2, Y1) rather than jumping ahead on
    // its early start date.
    const fa = isFullYear(ra), fb = isFullYear(rb);
    if (fa !== fb) return fa ? 1 : -1;
    if (ra.beg != null && rb.beg != null && ra.beg !== rb.beg) return ra.beg - rb.beg;
    return ai - bi;
  };
  const sortRec = (list) => {
    list.sort(byBeg);
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/**
 * Reduce a label to its "family shape" so recurrence can be counted:
 * ordinals (1ST/2ND/…) share one family, otherwise the alphabetic stem is the
 * family (PR1→PR, SM2→SM, Q1→Q, C3→C), a bare number → NUM.
 */
function familyShape(label) {
  const s = String(label).trim().toUpperCase();
  if (/^\d+(ST|ND|RD|TH)$/.test(s)) return 'ORD';
  const stem = s.replace(/\d+/g, '');
  if (stem) return stem;
  return 'NUM';
}

/**
 * Build the forest from ordering + family recurrence (Skyward, no dates).
 * Finer buckets recur more often across the year, so a smaller family count =
 * a coarser grain. Walking the ordered labels, each column adopts the run of
 * strictly-finer columns immediately preceding it (a monotonic-stack reduce),
 * which yields the cascade with the coarsest columns as roots.
 */
function nestByFrequency(orderedLabels) {
  const freq = {};
  for (const l of orderedLabels) {
    const f = familyShape(l);
    freq[f] = (freq[f] || 0) + 1;
  }
  // grain: higher = finer (recurs more). Coarser columns have a lower count.
  const grainOf = (label) => freq[familyShape(label)] || 0;

  const stack = [];
  for (const label of orderedLabels) {
    const n = node(label);
    const g = grainOf(label);
    while (stack.length && grainOf(stack[stack.length - 1].label) > g) {
      n.children.unshift(stack.pop());
    }
    stack.push(n);
  }
  return stack;
}

/**
 * Group columns by label family instead of by date/cascade hierarchy: one top
 * tab per letter type (PR, SM, Q, …) whose children are every column of that
 * family, in their original order. A group root is NOT a grade column (it has
 * no average of its own) and is flagged `group: true`; a family with a single
 * column (e.g. Y1) is emitted as a plain leaf tab. Groups are ordered coarsest
 * first (fewest members), ties by first appearance.
 */
function groupByFamily(orderedLabels) {
  const families = new Map();
  for (const l of orderedLabels) {
    const f = familyShape(l);
    if (!families.has(f)) families.set(f, []);
    families.get(f).push(l);
  }
  const labelSet = new Set(orderedLabels);
  const entries = [...families.entries()];
  const firstIdx = (members) => orderedLabels.indexOf(members[0]);
  entries.sort((a, b) => a[1].length - b[1].length || firstIdx(a[1]) - firstIdx(b[1]));
  return entries.map(([family, members]) => {
    if (members.length === 1) return node(members[0]);
    let label = family === 'ORD' ? 'Terms' : family === 'NUM' ? '#' : family;
    while (labelSet.has(label)) label += '*'; // never collide with a real column
    return { label, group: true, children: members.map((m) => node(m)) };
  });
}

export {
  node,
  groupByFamily,
  forestHasChildren,
  flattenForest,
  pathToLabel,
  nestByContainment,
  nestByFrequency,
  familyShape,
};
