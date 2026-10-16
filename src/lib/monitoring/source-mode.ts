export type SourceProcessingProvenance = {
  source_mode: string;
  processing_mode: string;
};

export function customerImpactDispatchAllowed(provenance: SourceProcessingProvenance) {
  if (provenance.source_mode === "provider" && provenance.processing_mode === "customer")
    return true;
  if (provenance.source_mode === "internal_test" && provenance.processing_mode === "evidence_only")
    return false;
  throw new Error("source_change_provenance_invalid");
}
