export const configuredEntity = "fixture-client";
const legacyClient = { send: () => "old" };
export const modernClient = { send: () => "new" };
export const client = legacyClient.send();
