// Entry point of the Node media server when Pulse runs under the Tauri host (src-tauri).
// The host passes PULSE_PORT / PULSE_SERVER_TOKEN / PULSE_USER_DATA / PULSE_PARENT_PID and waits for
// the "PULSE_READY {json}" line on stdout before it reports the server as up to the UI.
const server = require('../server/server');
const { createHostHandler, startupCookieSync } = require('./host-routes');

process.on('uncaughtException', (err) => { try { console.error('[pulse-host] uncaught', err); } catch (_) {} });
process.on('unhandledRejection', (err) => { try { console.error('[pulse-host] unhandled', err); } catch (_) {} });

server.registerRouteHandler(createHostHandler());

server.startServer(server.PORT).then((port) => {
  process.stdout.write('PULSE_READY ' + JSON.stringify({ port, pid: process.pid }) + '\n');
  // Same background cookie sync Electron did at startup (enables signed-in YouTube requests).
  setTimeout(() => { startupCookieSync().catch(() => {}); }, 3000).unref();
}).catch((err) => {
  console.error('[pulse-host] server failed to start', err);
  process.exit(1);
});

// Exit with the host even if it is killed without closing our job handle.
const parentPid = Number(process.env.PULSE_PARENT_PID) || 0;
if (parentPid) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch (_) { process.exit(0); }
  }, 2000).unref();
}
