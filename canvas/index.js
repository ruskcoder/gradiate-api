/**
 * Canvas LMS platform registry.
 *
 * The first platform here that talks to a documented REST API rather than
 * scraping HTML, which changes three things and nothing else:
 *
 *   - Auth is a bearer token, not a login handshake. The user pastes an access
 *     token from Canvas's own Account -> Settings -> "+ New Access Token" page,
 *     and core's `token` login type stamps it onto every request. There is no
 *     password, no cookie jar and no SSO dance to reproduce.
 *   - "Terms" are Canvas grading periods: flat, dated and non-overlapping, so
 *     `termTree` is flat (`hasSubterms: false`) and a synthetic `Total` column
 *     carries the whole-course grade — the role PowerSchool's Y1 plays.
 *   - It is an LMS, not a student information system. There is no attendance,
 *     report card, transcript, bell schedule or master schedule to return, so
 *     those routes are simply not implemented and core 404s them. In exchange it
 *     has something no portal does — assignments as first-class objects with
 *     real due/unlock/lock timestamps — which is what `/canvas/assignments` is.
 *
 * Login types:
 *   - token : `{ link, token }`, where `link` is the Canvas instance URL
 *             (`https://<district>.instructure.com`) and `token` is a user
 *             access token. Any path on the pasted link is discarded.
 */

import { formatLink, isSessionExpired } from './auth/token.js';
import { info } from './data/info.js';
import { classes, singleClass } from './data/classes.js';
import { teachers } from './data/teachers.js';
import { assignments } from './data/assignments.js';

export default {
  name: 'Canvas',
  mount: '/canvas',
  loginTypes: ['token'],
  // The profile is the cheapest authenticated call, so it doubles as the session
  // probe that turns a bad token into a clean 401 at /login.
  homeEndpoint: 'api/v1/users/self/profile',
  formatLink,
  isSessionExpired,
  data: {
    info,
    classes,
    singleClass,
    teachers,
    assignments,
  },
};
