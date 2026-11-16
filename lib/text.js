'use strict'
// Text cut to a host call's limit. The host counts UTF-16 units (`String.length`) for a notification's title and
// text, but Rooms counts code points for titles and messages: a limit is cut by the unit its own side counts.
// One helper for the host's limits, so a plugin text that goes into one never rests on a code point count (an emoji
// is two units: a title of 40 of them passed the plugin's cut and was refused by the host, silently, for every ask).

/** `ctx.notify` title: 1 to 80 UTF-16 units (cc-cockpit src/shared/notify.ts MAX_NOTIFY_TITLE; longer rejects). */
const NOTIFY_TITLE_MAX = 80
/** `ctx.notify` text: the host cuts it at 500 units itself, never rejects; cut here so the notice reads whole. */
const NOTIFY_TEXT_MAX = 500

/**
 * `text` in at most `max` UTF-16 units, the last one an ellipsis when it was cut; a surrogate pair is never split
 * (the cut backs up over a lone high surrogate).
 */
function cutUnits(text, max) {
  if (text.length <= max) return text
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return text.slice(0, end) + '…'
}

module.exports = { cutUnits, NOTIFY_TITLE_MAX, NOTIFY_TEXT_MAX }
