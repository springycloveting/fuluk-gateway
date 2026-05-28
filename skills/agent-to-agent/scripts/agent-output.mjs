#!/usr/bin/env node
/**
 * agent-output - Get output from a session via Session Gateway API
 *
 * Usage: agent-output <session-id-or-name> [lines]
 *
 * Environment variables:
 *   SESSION_GATEWAY_URL  - Session Gateway server URL (default: http://127.0.0.1:8787)
 *   SESSION_GATEWAY_TOKEN - Authentication token (required)
 */

const SESSION_GATEWAY_URL = process.env.SESSION_GATEWAY_URL || 'http://127.0.0.1:8787';
const SESSION_GATEWAY_TOKEN = process.env.SESSION_GATEWAY_TOKEN;

function printUsage() {
  console.log(`
Usage: agent-output <session-id-or-name> [lines]

Environment variables:
  SESSION_GATEWAY_URL   Session Gateway URL (default: http://127.0.0.1:8787)
  SESSION_GATEWAY_TOKEN Authentication token (required)

Examples:
  agent-output claude-worker
  agent-output abc-123-def 100
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    process.exit(args.length < 1 ? 1 : 0);
  }

  if (!SESSION_GATEWAY_TOKEN) {
    console.error('Error: SESSION_GATEWAY_TOKEN environment variable is required');
    process.exit(1);
  }

  const target = args[0];
  const lines = parseInt(args[1], 10) || 50;

  try {
    const response = await fetch(`${SESSION_GATEWAY_URL}/api/sessions/${encodeURIComponent(target)}/output?lines=${lines}`, {
      headers: {
        'Authorization': `Bearer ${SESSION_GATEWAY_TOKEN}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Error: ${response.status} - ${error}`);
      process.exit(1);
    }

    const output = await response.text();
    console.log(output);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
