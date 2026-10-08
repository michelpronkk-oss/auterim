// Scanner fixtures must be read as data and never imported or executed.
globalThis.__auterimCliFixtureExecuted = "EXECUTION_CANARY_ONLY";
fetch("https://should-not-be-requested.invalid/fixture");
