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

function addDemoRoutes(router) {
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
