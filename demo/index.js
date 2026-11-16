/**
 * Demo routes (GET /demo/...): canned responses with artificial delays, for
 * showing the app without a real portal account. The JSON lives next to this
 * file and is bundled into the Worker; each request gets a fresh copy because
 * the handlers edit it.
 */

import { json } from '../core/http.js';
import loginData from './login.json' with { type: 'json' };
import infoData from './info.json' with { type: 'json' };
import classesData from './classes.json' with { type: 'json' };
import attendanceData from './attendance.json' with { type: 'json' };
import { buildClasses } from './generate.js';

const streamMsgs = [
  'Loading...',
  'Almost there...',
  'Just a moment...',
  'Hang tight...',
  'So close...',
];

const encoder = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const monthLookup = {
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
};

// Module state, as before: one value per running instance.
let compSciAvg = '91.50';

async function readAndSend(data) {
  await sleep(1000);
  return json(200, structuredClone(data));
}

function classesPayload(term) {
  const data = structuredClone(classesData);
  data.term = term || data.term;
  data.classes[0].average = compSciAvg;
  return data;
}

function streamClasses(req) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  req.waitUntil((async () => {
    try {
      for (let percent = 0; percent < 5; percent += 1) {
        await writer.write(encoder.encode(JSON.stringify({ percent: percent * 20, message: streamMsgs[percent] }) + '\n\n'));
        await sleep(1000);
      }
      await writer.write(encoder.encode(JSON.stringify(classesPayload(req.query.term))));
    } catch { /* client went away */ }
    await writer.close().catch(() => {});
  })());
  return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function attendancePayload(date) {
  let fileData = JSON.stringify(attendanceData);
  const now = new Date();
  if (date) {
    const [month, year] = String(date).split('-');
    fileData = fileData.replaceAll('MMM', month);
    fileData = fileData.replaceAll('YYYY', year);
    fileData = fileData.replaceAll('MM', monthLookup[month]);
    fileData = fileData.replaceAll('YY', year.slice(-2));
  } else {
    const month = String(now.getMonth() + 1).padStart(2, '0');
    fileData = fileData.replaceAll('MMM', Object.entries(monthLookup).find(([, num]) => num === month)[0]);
    fileData = fileData.replaceAll('YYYY', String(now.getFullYear()));
    fileData = fileData.replaceAll('MM', String(now.getMonth() + 1));
    fileData = fileData.replaceAll('YY', String(now.getFullYear()).slice(-2));
  }
  return JSON.parse(fileData);
}

const DEMO_USER = {
  username: 'testuser',
  name: 'Test User',
  grade: '10',
  school: 'Gradiate High School',
  district: 'Demo',
  dob: '',
  link: 'https://gradiate.app/',
};
const DEMO_SESSION = { cookies: {}, cache: {}, loginMetadata: {} };

/** POST /demo/classes with `stream: true`: progress chunks, then the payload. */
function streamGeneratedClasses(req, term) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  req.waitUntil((async () => {
    try {
      for (let step = 0; step < 5; step += 1) {
        await writer.write(encoder.encode(JSON.stringify({ percent: step * 20, message: streamMsgs[step] }) + '\n\n'));
        await sleep(400 + Math.random() * 400);
      }
      await writer.write(encoder.encode(JSON.stringify({ success: true, ...buildClasses(term), session: DEMO_SESSION })));
    } catch { /* client went away */ }
    await writer.close().catch(() => {});
  })());
  return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

/**
 * The POST platform interface (`/demo/info`, `/demo/classes`, ...) the web app
 * uses for the demo account. Anything other than info/classes is not built.
 */
function addDemoPlatformRoutes(router) {
  router.post('/demo', () => json(200, { message: 'Demo API', success: true }));
  router.post('/demo/info', async () => {
    await sleep(800);
    return json(200, { success: true, ...DEMO_USER, session: DEMO_SESSION });
  });
  router.post('/demo/classes', async (req) => {
    const term = req.body?.options?.term || '';
    if (req.body?.stream === true || req.body?.stream === 'true') return streamGeneratedClasses(req, term);
    await sleep(1500);
    return json(200, { success: true, ...buildClasses(term), session: DEMO_SESSION });
  });
  router.post('/demo/single-class', async (req) => {
    const { course, term } = req.body?.options || {};
    const data = buildClasses(term);
    const cls = data.classes.find((c) => c.course === course);
    if (!cls) return json(404, { success: false, message: 'Class not found' });
    return json(200, { success: true, ...cls, session: DEMO_SESSION });
  });
  for (const path of ['/schedule', '/bellSchedule', '/attendance', '/teachers', '/reportCard', '/ipr', '/transcript']) {
    router.post(`/demo${path}`, () => json(404, { success: false, message: 'Not available in demo mode' }));
  }
}

function addDemoRoutes(router) {
  addDemoPlatformRoutes(router);
  router.get('/demo', () => new Response('Demo App', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  router.get('/demo/login', () => readAndSend(loginData));
  router.get('/demo/info', () => readAndSend(infoData));

  router.get('/demo/setAvg', (req) => {
    compSciAvg = req.query.new || '91.50';
    return json(200, { message: 'Average set successfully', average: compSciAvg });
  });

  router.get('/demo/classes', async (req) => {
    if (req.query.stream == 'true') return streamClasses(req);
    await sleep(3000);
    return json(200, classesPayload(req.query.term));
  });

  router.get('/demo/attendance', async (req) => {
    let payload;
    try {
      payload = attendancePayload(req.query.date);
    } catch (error) {
      return json(200, { error: error.message });
    }
    await sleep(2000);
    return json(200, payload);
  });

  return router;
}

export { addDemoRoutes };
