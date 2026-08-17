import type {
  BusinessCategory,
  BusinessLocation,
  BusinessProfile,
  SearchGeoMode,
} from "../types";
import type { GuardrailOverride } from "../guardrails";

export type SearchDispatchOptions = {
  geo?: string;
  businessProfile?: BusinessProfile | null;
  businessUrl?: string | null;
  geoMode?: SearchGeoMode | null;
  selectedCategory?: BusinessCategory | null;
  targetLocations?: BusinessLocation[] | null;
  keywordLocation?: string | null;
  skipGuardrails?: boolean;
  guardrailOverride?: GuardrailOverride | null;
};
