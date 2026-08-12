/**
 * Repository identifier utilities.
 *
 * GitHub repository names and owner logins are case-insensitive.
 * This module provides normalization functions to ensure consistent storage
 * and comparison of repository identifiers in the slack-bot.
 */

/**
 * Normalize repository owner/name to lowercase for consistent storage.
 *
 * @param owner - Repository owner (user or organization)
 * @param name - Repository name
 * @returns Normalized identifier in the format "owner/name"
 */
export function normalizeRepoId(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
