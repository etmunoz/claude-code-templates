import type { APIRoute } from 'astro';
import { corsResponse, jsonResponse } from '../../lib/api/cors';
import { getNeonClient } from '../../lib/api/neon';
import { readJsonLimited, clampStr, clampInt, clampJson, PayloadTooLargeError } from '../../lib/api/input';

const VALID_EVENT_TYPES = [
  'search',
  'cart_add',
  'cart_remove',
  'cart_checkout',
  'component_view',
  'copy_command',
];

const MAX_EVENTS_PER_BATCH = 50;

function validateEventsData(data: { events?: Array<{ event_type?: string }> }) {
  const { events } = data;

  if (!events || !Array.isArray(events) || events.length === 0) {
    return { valid: false, error: 'events array is required and must not be empty' };
  }

  if (events.length > MAX_EVENTS_PER_BATCH) {
    return { valid: false, error: `Maximum ${MAX_EVENTS_PER_BATCH} events per batch` };
  }

  for (const event of events) {
    if (!event.event_type || !VALID_EVENT_TYPES.includes(event.event_type)) {
      return { valid: false, error: `Invalid event_type: ${event.event_type}` };
    }
  }

  return { valid: true, error: null };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    // CCT-08: batch endpoint — allow a larger body for up to 50 events, still bounded.
    const {
      events,
      session_id,
      visitor_id,
      screen_width,
      referrer,
    } = await readJsonLimited(request, 128 * 1024);

    const validation = validateEventsData({ events });
    if (!validation.valid) {
      return jsonResponse({ error: validation.error }, 400);
    }

    const country = request.headers.get('x-vercel-ip-country') || null;
    // CCT-08: cap batch-level fields once; per-event fields are capped in the loop.
    const cappedReferrer = clampStr(referrer, 1000);
    const cappedSession = clampStr(session_id, 128);
    const cappedVisitor = clampStr(visitor_id, 128);
    const cappedWidth = clampInt(screen_width, 0, 100000);
    const sql = getNeonClient();

    let inserted = 0;
    for (const event of events) {
      await sql`
        INSERT INTO website_events (
          event_type, event_data, page_path,
          referrer, session_id, visitor_id,
          country, screen_width
        ) VALUES (
          ${event.event_type},
          ${clampJson(event.event_data)},
          ${clampStr(event.page_path, 512)},
          ${cappedReferrer},
          ${cappedSession},
          ${cappedVisitor},
          ${country},
          ${cappedWidth}
        )
      `;
      inserted++;
    }

    return jsonResponse({
      success: true,
      message: `${inserted} events tracked`,
      data: { count: inserted, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse({ error: 'Request body too large' }, 413);
    }
    console.error('Website events tracking error:', error);
    return jsonResponse(
      {
        error: 'Internal server error',
        message: 'Failed to track website events',
      },
      500
    );
  }
};

export const OPTIONS: APIRoute = async () => corsResponse();
