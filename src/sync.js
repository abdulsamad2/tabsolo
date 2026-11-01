'use strict';

/**
 * Automatiq Sync (formerly SeatScouts) API client — order feed only.
 * Docs: https://docs.automatiq.com/sync/reference/list_orders
 * Auth: every request carries X-Company-Id and X-Api-Token (Sync → Settings). Rate limit: 100/min.
 */

const SYNC_BASE_URL = 'https://app.seatscouts.com';
// `invoiced` isn't in Automatiq's docs, but it's what a new sale that hasn't been fulfilled yet carries.
const ORDER_STATUSES = ['invoiced', 'pending', 'problem', 'confirmed', 'confirmed_delay', 'delivery_problem', 'delivered', 'retransfer_required', 'rejected'];
const MARKETPLACES = ['axs', 'fanxchange', 'gametime', 'go_tickets', 'seatgeek', 'stubhub', 'ticket_evo', 'ticket_network_mp', 'ticketmaster', 'tickpick', 'viagogo', 'vividseats'];
const MAX_PAGE_SIZE = 100;

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const csvOf = (value, allowed) => String(value ?? '')
  .split(',').map((v) => v.trim().toLowerCase()).filter((v) => allowed.includes(v)).join(',');

/** Builds the Get Orders URL from UI filters, dropping anything the API wouldn't accept. */
function ordersURL(params = {}, baseURL = SYNC_BASE_URL) {
  const url = new URL('/sync/api/orders', baseURL);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(params.limit)) || 50));
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));
  const status = csvOf(params.status, ORDER_STATUSES);
  if (status) url.searchParams.set('status', status);
  const marketplace = csvOf(params.marketplace, MARKETPLACES);
  if (marketplace) url.searchParams.set('marketplace', marketplace);
  const search = String(params.search ?? '').trim();
  // A bare number is an order number; anything else searches event names.
  if (/^\d{4,}$/.test(search)) url.searchParams.set('order_id', search);
  else if (search) url.searchParams.set('event_name', search.slice(0, 200));
  if (isDate(params.dateFrom)) url.searchParams.set('order_date_from', params.dateFrom);
  if (isDate(params.dateTo)) url.searchParams.set('order_date_to', params.dateTo);
  url.searchParams.set('order_by', ['created_at', 'occurs_at', 'in_hand'].includes(params.orderBy) ? params.orderBy : 'created_at');
  url.searchParams.set('order_by_direction', params.direction === 'asc' ? 'asc' : 'desc');
  return url;
}

/** A short, human message for a failed response; never echoes credentials. */
function describeFailure(status, body) {
  if (status === 401 || status === 403) return 'Automatiq rejected the Company ID or API token. Check them in Settings → Automatiq Sync.';
  if (status === 429) return 'Automatiq rate limit reached (100 requests a minute). Try again shortly.';
  let detail = '';
  try {
    const data = JSON.parse(body);
    detail = data.error ?? data.message ?? data.errors?.[0]?.detail ?? data.errors?.[0]?.title ?? '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {}
  // Control chars out so a hostile upstream can't break the toast or hide text; cap length.
  const clean = String(detail).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 160);
  return `Automatiq returned HTTP ${status}${clean ? `: ${clean}` : ''}.`;
}

/**
 * Fetches one page of orders. `fetchImpl` is Electron's net.fetch in the app (respects system proxy
 * settings) and a stub in tests. Returns { count, page, limit, orders } or { error }.
 */
async function fetchOrders(fetchImpl, credentials, params = {}, baseURL = SYNC_BASE_URL) {
  if (!credentials?.companyId || !credentials?.apiToken) {
    return { error: 'Add your Automatiq Sync Company ID and API token in Settings first.', needsSetup: true };
  }
  const url = ordersURL(params, baseURL);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        'X-Company-Id': String(credentials.companyId),
        'X-Api-Token': String(credentials.apiToken),
        Accept: 'application/json',
      },
    });
  } catch (error) {
    return { error: `Couldn't reach Automatiq: ${String(error?.message ?? error).split('\n')[0]}` };
  }
  const body = await response.text();
  if (!response.ok) return { error: describeFailure(response.status, body), status: response.status };
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'Automatiq sent a response that isn\'t JSON.' };
  }
  const orders = Array.isArray(data?.data) ? data.data : [];
  return {
    count: Number(data?.count) || orders.length,
    page: Number(data?.page) || Number(url.searchParams.get('page')),
    limit: Number(url.searchParams.get('limit')),
    orders,
  };
}

/**
 * Prefers a direct event URL when the order record carries one (Automatiq sometimes includes
 * `event_url` / `primary_marketplace_url` depending on the integration). Falls back to a
 * Ticketmaster search by event name + date — TM has no venue or time filter, and adding the venue
 * to the keywords often finds nothing (venue names differ between marketplaces), so those go in
 * the tab's note instead.
 */
function eventSearchURL(event = {}) {
  const direct = String(
    event.eventURL ?? event.event_url
    ?? event.primaryMarketplaceURL ?? event.primary_marketplace_url
    ?? event.ticketURL ?? event.ticket_url ?? ''
  ).trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  const name = String(event.eventName ?? '').trim();
  if (!name) return null;
  const url = new URL('https://www.ticketmaster.com/search');
  url.searchParams.set('q', name.slice(0, 200));
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(String(event.occursAt ?? ''))?.[1];
  if (date) {
    url.searchParams.set('startDate', date);
    url.searchParams.set('endDate', date);
  }
  return url.toString();
}

/** Plain-text order summary for the search tab's note. */
function eventSearchNote(event = {}) {
  const [date, time = ''] = String(event.occursAt ?? '').split('T');
  const clock = /^(\d{2}):(\d{2})/.exec(time);
  const when = [date, clock && `${((Number(clock[1]) + 11) % 12) + 1}:${clock[2]} ${Number(clock[1]) < 12 ? 'AM' : 'PM'}`].filter(Boolean).join(' ');
  return [
    event.eventName,
    event.venueName && `Venue: ${event.venueName}${event.city ? `, ${event.city}` : ''}`,
    when && `Date: ${when}`,
    [event.section && `Sec ${event.section}`, event.row && `Row ${event.row}`, event.quantity && `Qty ${event.quantity}`].filter(Boolean).join(' · '),
    event.orderId && `Order #${event.orderId}${event.marketplace ? ` (${event.marketplace})` : ''}`,
  ].filter(Boolean).join('\n');
}



module.exports = { eventSearchURL, eventSearchNote, SYNC_BASE_URL, ORDER_STATUSES, MARKETPLACES, MAX_PAGE_SIZE, ordersURL, fetchOrders, describeFailure };
