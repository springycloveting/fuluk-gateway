#!/usr/bin/env node
/**
 * agent-send - Send a message to another agent session via Session Gateway API
 *
 * Usage: agent-send <session-id-or-name> <message>
 *
 * Environment variables:
 *   SESSION_GATEWAY_URL  - Session Gateway server URL (default: http://127.0.0.1:8787)
 *   SESSION_GATEWAY_TOKEN - Authentication token (required)
 */

const SESSION_GATEWAY_URL = process.env.SESSION_GATEWAY_URL || 'http://127.0.0.1:8787';
const SESSION_GATEWAY_TOKEN = process.env.SESSION_GATEWAY_TOKEN;

function printUsage() {
  console.log(`
Usage: agent-send <session-id-or-name> <message>

Environment variables:
  SESSION_GATEWAY_URL   Session Gateway URL (default: http://127.0.0.1:8787)
  SESSION_GATEWAY_TOKEN Authentication token (required)

Examples:
  agent-send claude-worker "请检查 auth.mjs 的验证逻辑"
  agent-send abc-123-def "运行测试"
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    process.exit(args.length < 2 ? 1 : 0);
  }

  if (!SESSION_GATEWAY_TOKEN) {
    console.error('Error: SESSION_GATEWAY_TOKEN environment variable is required');
    process.exit(1);
  }

  const [target, ...messageParts] = args;
  const message = messageParts.join(' ');

  try {
    const response = await fetch(`${SESSION_GATEWAY_URL}/api/sessions/${encodeURIComponent(target)}/input`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SESSION_GATEWAY_TOKEN}`
      },
      body: JSON.stringify({ text: message })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Error: ${response.status} - ${error}`);
      process.exit(1);
    }

    const result = await response.json();
    console.log(`✓ Message sent to session: ${target}`);
    console.log(`  Message: ${message.slice(0, 50)}${message.length > 50 ? '...' : ''}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
