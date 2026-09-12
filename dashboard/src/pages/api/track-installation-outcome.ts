import type { APIRoute } from 'astro';
import { corsResponse, jsonResponse } from '../../lib/api/cors';
import { getNeonClient } from '../../lib/api/neon';
import { captureApiError } from '../../lib/api/error-tracking';
import { readJsonLimited, clampStr, clampStrOr, clampInt, PayloadTooLargeError } from '../../lib/api/input';

function validateOutcomeData(data: {
  componentType?: string;
  componentName?: string;
  outcome?: string;
}) {
  const { componentType, componentName, outcome } = data;

  if (!componentType || !componentName || !outcome) {
    return { valid: false, error: 'componentType, componentName, and outcome are required' };
  }

  const validTypes = ['agent', 'command', 'mcp', 'setting', 'hook', 'skill', 'template'];
  if (!validTypes.includes(componentType)) {
    return { valid: false, error: 'Invalid component type' };
  }

  const validOutcomes = ['success', 'failure', 'partial'];
  if (!validOutcomes.includes(outcome)) {
    return { valid: false, error: 'Invalid outcome. Must be: success, failure, or partial' };
  }

  if (componentName.length > 255) {
    return { valid: false, error: 'Component name too long' };
  }

  return { valid: true, error: null };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const {
      componentType,
      componentName,
      outcome,
      errorType,
      errorMessage,
      durationMs,
      cliVersion,
      nodeVersion,
      platform,
      arch,
      batchId,
    } = await readJsonLimited(request);

    const validation = validateOutcomeData({ componentType, componentName, outcome });
    if (!validation.valid) {
      return jsonResponse({ error: validation.error }, 400);
    }

    const sql = getNeonClient();

    // CCT-08: bound every free-form field before it reaches the database.
    await sql`
      INSERT INTO installation_outcomes (
        component_type, component_name, outcome,
        error_type, error_message, duration_ms,
        cli_version, node_version, platform, arch, batch_id
      ) VALUES (
        ${componentType},
        ${componentName},
        ${outcome},
        ${clampStr(errorType, 100)},
        ${clampStr(errorMessage, 1000)},
        ${clampInt(durationMs)},
        ${clampStrOr(cliVersion, 'unknown', 50)},
        ${clampStrOr(nodeVersion, 'unknown', 50)},
        ${clampStrOr(platform, 'unknown', 50)},
        ${clampStrOr(arch, 'unknown', 50)},
        ${clampStr(batchId, 128)}
      )
    `;

    return jsonResponse({
      success: true,
      message: 'Installation outcome tracked',
      data: { componentType, componentName, outcome, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse({ error: 'Request body too large' }, 413);
    }
    console.error('Installation outcome tracking error:', error);
    await captureApiError(error, { route: '/api/track-installation-outcome' });
    return jsonResponse(
      {
        error: 'Internal server error',
        message: 'Failed to track installation outcome',
      },
      500
    );
  }
};

export const OPTIONS: APIRoute = async () => corsResponse();
