/**
 * Paged ArcGIS REST query helper
 *
 * ArcGIS services cap each query response at the layer's maxRecordCount
 * (2,000 for both MTC and San Jose) and set exceededTransferLimit when more
 * features matched. A single unpaged query silently returns only the first
 * page, so every query goes through here and keeps requesting with
 * resultOffset until the service stops reporting more.
 */

const PAGE_SIZE = 1000;
const MAX_PAGES = 200; // Guard against a service that never clears the flag

/**
 * Fetch every feature matching a query, following exceededTransferLimit.
 * `params` are the query's own parameters (where, outFields, ...);
 * `orderByFields` should name the layer's object ID field so pages are stable.
 */
async function queryAllFeatures(layerUrl, params, { orderByFields } = {}) {
  const features = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      ...params,
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
      f: 'json'
    });
    if (orderByFields) {
      query.set('orderByFields', orderByFields);
    }

    // POST, not GET: a polygon or envelope geometry can push the URL past
    // server limits.
    const response = await fetch(`${layerUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: query
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`API error: ${data.error.message}`);
    }

    const pageFeatures = data.features || [];
    features.push(...pageFeatures);

    if (!data.exceededTransferLimit || pageFeatures.length === 0) {
      return features;
    }
  }

  throw new Error(`Query to ${layerUrl} still had more results after ${MAX_PAGES} pages`);
}

module.exports = {
  queryAllFeatures
};
