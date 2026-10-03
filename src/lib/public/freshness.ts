export const MAX_PUBLIC_EVIDENCE_AGE_DAYS = 45;

export function isPublicEvidenceFresh(lastVerifiedAt: string, now = Date.now()) {
  const verifiedAt = Date.parse(lastVerifiedAt);
  return (
    Number.isFinite(verifiedAt) &&
    verifiedAt <= now &&
    now - verifiedAt <= MAX_PUBLIC_EVIDENCE_AGE_DAYS * 24 * 60 * 60 * 1000
  );
}
