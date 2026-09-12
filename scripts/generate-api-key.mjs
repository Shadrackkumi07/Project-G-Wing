#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";

const key = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(key).digest("hex");

console.log(`
Generated one API key for this service.

  Give to the caller (shown once — it cannot be recovered):

    ${key}

  Set on the server:

    API_KEY_HASHES=${hash}

To accept several keys, run this again and join the hashes with commas.
`);
