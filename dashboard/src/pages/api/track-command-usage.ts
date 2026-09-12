import type { APIRoute } from 'astro';
import { corsResponse, jsonResponse } from '../../lib/api/cors';
import { getNeonClient } from '../../lib/api/neon';
import { captureApiError } from '../../lib/api/error-tracking';
import { readJsonLimited, clampStr, clampStrOr, clampJson, PayloadTooLargeError } from '../../lib/api/input';

const VALID_COMMANDS = [
  'chats',
  'analytics',
  'health-check',
  'plugins',
  'sandbox',
  'agents',
  'chats-mobile',
  'studio',
  'command-stats',
  'hook-stats',
  'mcp-stats',
  'skills-manager',
  '2025-year-in-review',
];

function validateCommandData(data: { command?: string }) {
  const { command } = data;

  if (!command) {
    return { valid: false, error: 'Command name is required' };
  }

  if (!VALID_COMMANDS.includes(command)) {
    return { valid: false, error: 'Invalid command name' };
  }

  if (command.length > 100) {
    return { valid: false, error: 'Command name too long' };
  }

  return { valid: true, error: null };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const {
      command,
      cliVersion,
      nodeVersion,
      platform,
      arch,
      sessionId,
      metadata,
    } = await readJsonLimited(request);

    const validation = validateCommandData({ command });
    if (!validation.valid) {
      return jsonResponse({ error: validation.error }, 400);
    }

    const sql = getNeonClient();

    // CCT-08: bound every free-form field before it reaches the database.
    await sql`
      INSERT INTO command_usage_logs (
        command_name,
        cli_version,
        node_version,
        platform,
        arch,
        session_id,
        metadata
      ) VALUES (
        ${command},
        ${clampStrOr(cliVersion, 'unknown', 50)},
        ${clampStrOr(nodeVersion, 'unknown', 50)},
        ${clampStrOr(platform, 'unknown', 50)},
        ${clampStrOr(arch, 'unknown', 50)},
        ${clampStr(sessionId, 128)},
        ${clampJson(metadata)}
      )
    `;

    return jsonResponse({
      success: true,
      message: 'Command execution tracked successfully',
      data: { command, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse({ error: 'Request body too large' }, 413);
    }
    console.error('Command tracking error:', error);
    await captureApiError(error, { route: '/api/track-command-usage' });
    return jsonResponse(
      {
        error: 'Internal server error',
        message: 'Failed to track command execution',
      },
      500
    );
  }
};

export const OPTIONS: APIRoute = async () => corsResponse();
