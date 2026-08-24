export interface PlaceResult {
  name: string;
  website: string;
  address: string;
}

// Bounding box covering Santa Clara + San Mateo counties — SVBC's member businesses
// all have offices or retail locations there, so bias (not restrict) results to it.
const COUNTY_BOUNDS = {
  low: { latitude: 36.9, longitude: -122.6 },
  high: { latitude: 37.75, longitude: -121.2 },
};

interface PlacesResponse {
  places?: {
    displayName?: { text?: string };
    websiteUri?: string;
    formattedAddress?: string;
  }[];
}

export async function searchPlace(
  query: string,
  deps: { apiKey: string; fetchFn?: typeof fetch }
): Promise<PlaceResult | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': deps.apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.formattedAddress',
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: { rectangle: COUNTY_BOUNDS },
      pageSize: 1,
    }),
  });
  if (!response.ok) {
    throw new Error(`places: HTTP ${response.status}`);
  }
  const json = (await response.json()) as PlacesResponse;
  const place = json.places?.[0];
  if (!place) return null;
  return {
    name: place.displayName?.text ?? '',
    website: place.websiteUri ?? '',
    address: place.formattedAddress ?? '',
  };
}
