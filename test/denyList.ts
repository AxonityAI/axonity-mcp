/**
 * The deny-list lives in `src/denyList.ts`: the client checks it on every call
 * at run time, and the tests read the same list. Re-exported here so the tests
 * that import it from `./denyList.js` keep doing so.
 */
export * from "../src/denyList.js";
