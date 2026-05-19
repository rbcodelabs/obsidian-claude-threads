/**
 * Returns true if `title` is a default auto-generated thread name ("Thread 1", "Thread 42", etc.)
 * and has not been customised by the user or auto-summarizer.
 */
export function isDefaultThreadTitle(title: string): boolean {
  return /^Thread \d+$/.test(title);
}
