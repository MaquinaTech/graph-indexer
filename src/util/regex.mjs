/** A string as a literal inside a regular expression: every metacharacter escaped. */
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
