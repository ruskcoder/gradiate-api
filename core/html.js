/**
 * HTML loading for every platform scraper: a drop-in for `cheerio.load`.
 *
 * Plain `cheerio.load` parses with parse5, the spec-exact HTML parser. On the
 * portal pages it measured 3–6x slower than htmlparser2 on a cold isolate, and
 * cold isolates are the norm on Workers. So pages are parsed with htmlparser2
 * and handed to cheerio's slim build, which keeps the same `$` API.
 *
 * The one parse5 behaviour the scrapers depend on is the implied <tbody>:
 * ASP.NET writes table rows straight under <table>, parse5 wraps them in a
 * <tbody>, and selectors like `table > tbody > tr` rely on that. htmlparser2
 * builds the tree as written, so `implyTbody` adds the same wrapper.
 *
 * Platform files import this as `cheerio` so their `cheerio.load(...)` calls
 * stay unchanged.
 */

import { parseDocument } from 'htmlparser2';
import { Element } from 'domhandler';
import { load as loadDom } from 'cheerio/slim';

const isBlankText = (node) => node.type === 'text' && !/\S/.test(node.data);

function relink(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].prev = nodes[i - 1] ?? null;
    nodes[i].next = nodes[i + 1] ?? null;
  }
}

/** Wrap each run of <tr> written directly under a <table> in a <tbody>, as parse5 does. */
function wrapRows(table) {
  const out = [];
  let body = null;
  for (const child of table.children) {
    if (child.type === 'tag' && child.name === 'tr') {
      if (!body) {
        body = new Element('tbody', {}, []);
        body.parent = table;
        out.push(body);
      }
      child.parent = body;
      body.children.push(child);
    } else if (body && (isBlankText(child) || child.type === 'comment')) {
      child.parent = body;
      body.children.push(child);
    } else {
      body = null;
      out.push(child);
    }
  }
  for (const node of out) if (node.name === 'tbody') relink(node.children);
  relink(out);
  table.children = out;
}

function implyTbody(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    const children = node.children;
    if (!children || children.length === 0) continue;
    if (node.type === 'tag' && node.name === 'table' && children.some((c) => c.type === 'tag' && c.name === 'tr')) {
      wrapRows(node);
    }
    for (const child of node.children) if (child.children) stack.push(child);
  }
  return root;
}

/** Parse HTML into cheerio's `$`. Non-string input is passed to cheerio unchanged. */
function load(content) {
  if (typeof content !== 'string') return loadDom(content);
  const document = parseDocument(content);
  return loadDom(/<tr\b/i.test(content) ? implyTbody(document) : document);
}

export { load, implyTbody };
