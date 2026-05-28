#!/usr/bin/env node
/**
 * agent-list - List all sessions via Session Gateway API
 *
 * Usage: agent-list [--running]
 *
 * Environment variables:
 *   SESSION_GATEWAY_URL  - Session Gateway server URL (default: http://127.0.0.1:8787)
 *   SESSION_GATEWAY_TOKEN - Authentication token (required)
 */

const SESSION_GATEWAY_URL = process.env.SESSION_GATEWAY_URL || 'http://127.0.0.1:8787';
const SESSION_GATEWAY_TOKEN = process.env.SESSION_GATEWAY_TOKEN;

async function main() {
  const showRunningOnly = process.argv.includes('--running') || process.argv.includes('-r');

  if (!SESSION_GATEWAY_TOKEN) {
    console.error('Error: SESSION_GATEWAY_TOKEN environment variable is required');
    process.exit(1);
  }

  try {
    const response = await fetch(`${SESSION_GATEWAY_URL}/api/sessions`, {
      headers: {
        'Authorization': `Bearer ${SESSION_GATEWAY_TOKEN}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Error: ${response.status} - ${error}`);
      process.exit(1);
    }

    const data = await response.json();
    const sessions = data.sessions || [];

    const filtered = showRunningOnly
      ? sessions.filter(s => s.status === 'running')
      : sessions;

    if (filtered.length === 0) {
      console.log(showRunningOnly ? 'No running sessions found.' : 'No sessions found.');
      return;
    }

    console.log(`\nSessions (${filtered.length}):\n`);
    console.log('  ID                Name                 Status     Kind');
    console.log('  ─────────────────────────────────────────────────────');

    for (const session of filtered) {
      const id = session.id.slice(0, 8);
      const name = (session.name || '-').padEnd(20);
      const status = session.status.padEnd(10);
      const kind = session.kind || '-';
      console.log(`  ${id}  ${name} ${status} ${kind}`);
    }
    console.log('');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
