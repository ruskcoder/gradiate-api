/**
 * Runtime configuration.
 *
 * On Cloudflare Workers, secrets and bindings arrive as the `env` argument of
 * each handler; nothing can be read at module load time. The entry point calls
 * `bindEnv(env)` before any route runs, and every other module reads this shared
 * object lazily (inside functions, never at import time).
 *
 * Tests and local scripts can bind any plain object, e.g. `bindEnv(process.env)`.
 */

const env = {};
let boundFrom = null;

function bindEnv(source) {
  // The runtime hands every request in an isolate the same env object, so copy
  // it once rather than on every request.
  if (!source || source === boundFrom) return env;
  boundFrom = source;
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, source);
  return env;
}

export { env, bindEnv };
