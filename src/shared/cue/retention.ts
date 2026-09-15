/**
 * Cue history retention
 *
 * How long a Cue run stays in `cue_events` before the engine prunes it. The
 * value is a user setting (`cueHistoryRetentionDays`), so the default lives
 * here rather than being spelled out again in settings metadata, the renderer
 * store, and the main-process defaults - three copies of `14` is three places
 * for the number to drift, and a prune window that disagrees with the value the
 * UI shows deletes rows the user believes they still have.
 */

/**
 * Days of Cue run history kept by default.
 *
 * Two weeks covers the Activity Log's useful lookback (a user asking "did this
 * pipeline fire last Tuesday?") without letting a heartbeat-heavy fleet grow
 * the database without bound - the measured fleet writes ~2,800 Cue rows a day.
 */
export const DEFAULT_CUE_HISTORY_RETENTION_DAYS = 14;
