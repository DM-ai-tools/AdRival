import type {
  BusinessCategory,
  BusinessLocation,
  BusinessProfile,
  SearchGeoMode,
} from "../types";

export type SearchDispatchOptions = {
  geo?: string;
  businessProfile?: BusinessProfile | null;
  businessUrl?: string | null;
  geoMode?: SearchGeoMode | null;
  selectedCategory?: BusinessCategory | null;
  targetLocations?: BusinessLocation[] | null;
  keywordLocation?: string | null;
};
