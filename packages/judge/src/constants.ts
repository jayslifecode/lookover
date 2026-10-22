/**
 * How many fresh browser contexts a candidate is measured again in before it is reported: a step finding
 * is confirmed only when every one of them reproduced it.
 */
export const REPRODUCTION_ATTEMPTS = 3;

/** How many isolated contexts the judge keeps open at once beside the crawl's own page. */
export const JUDGE_CONCURRENCY = 2;
