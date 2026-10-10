'use strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- An ordinary native development extension loads a CommonJS entry.
const fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep this disposable CommonJS fixture synchronous during activation.
const path = require('node:path');
const stages = [];
function stage(name, detail) {
  stages.push({ name, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  fs.writeFileSync(path.join(__dirname, 'fixture-stages.json'), JSON.stringify(stages));
}
stage('entry-loaded');

/** Ordinary disposable development extension. Only the HTTP transport is a fixture;
 * activation, encrypted SecretStorage, contributed UI, settings, and runtime use
 * the byte-identical packaged Little Code production bundle.
 */
exports.activate = function activate(context) {
  stage('activation-entered', context.extension.id);
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-config.json'), 'utf8'));
  const endpoint = new URL(fixture.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Native Groq fixture endpoint is not an owned loopback origin.');
  const originalFetch = globalThis.fetch;
  const fixtureFetch = function fetchGroqFixture(input, options) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (target.origin !== 'https://api.groq.com' || !['/openai/v1/models', '/openai/v1/chat/completions'].includes(target.pathname) || target.search || target.hash) {
      throw new Error('The native Groq fixture allows only its owned API transport.');
    }
    return originalFetch(`${endpoint.origin}${target.pathname}`, options);
  };
  globalThis.fetch = fixtureFetch;
  context.subscriptions.push({ dispose() { if (globalThis.fetch === fixtureFetch) globalThis.fetch = originalFetch; } });
  stage('transport-configured');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise the exact packaged production CommonJS bundle without rebuilding it.
  const production = require('./dist/extension.cjs');
  stage('production-bundle-loaded');
  production.activate(context);
  stage('production-activated');
  fs.writeFileSync(path.join(__dirname, 'fixture-activation.json'), JSON.stringify({ activated: true, extensionId: context.extension.id, fixtureTransport: endpoint.origin }));
};
