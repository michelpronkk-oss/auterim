export const legacyClient = {
  send(): string {
    return "fixture response";
  },
};

export const modernClient = {
  send(): string {
    return "fixture response";
  },
};

export function sendFixtureMessage() {
  return legacyClient.send();
}
