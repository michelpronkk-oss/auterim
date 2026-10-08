export function isRepositoryProtectedForProduct(input: {
  selectedForProtection: boolean;
  productId: string;
  mappings: Array<{ protected_product_id: string; status: string }>;
}) {
  if (input.mappings.length > 0) {
    return input.mappings.some(
      (mapping) => mapping.protected_product_id === input.productId && mapping.status === "active",
    );
  }
  return input.selectedForProtection;
}
