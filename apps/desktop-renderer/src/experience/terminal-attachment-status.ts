/**
 * One honesty fix for the status strip (m50).
 *
 * The strip's "safe state" line comes from a daemon projection, and the daemon
 * writes "No desktop terminal attachment is open" because it genuinely cannot
 * know: an attachment is a renderer-side lease over a socket the daemon serves
 * but does not observe on the projection's behalf. So the line was printed under
 * a connected, typed-into terminal — the app contradicting itself on screen.
 *
 * The renderer knows. This is where the fact it knows replaces the sentence it
 * cannot support. Kept pure and separate because a status line that lies is
 * exactly the kind of thing that comes back, and this is where a test can pin it.
 */

export interface StatusStripCopy {
  readonly state: string;
  readonly message: string;
  readonly safeState: string;
  readonly nextAction: string;
}

/**
 * The projection's own wording for "nothing is attached". Matched rather than
 * assumed positionally: if the daemon rewords it, the override stops firing and
 * the strip shows the daemon's sentence, which is the safe direction to fail.
 */
export const NO_ATTACHMENT_SAFE_STATE = "No desktop terminal attachment is open";
const NO_ATTACHMENT_NEXT_ACTION = "Choose a terminal pane";

const ATTACHED_SAFE_STATE = "A desktop terminal attachment is open";
const ATTACHED_NEXT_ACTION = "Type in the focused pane";

/**
 * Replace the "nothing is attached" copy while something IS attached.
 *
 * Only that exact pair is replaced. Every other status — degraded, reconnecting,
 * a session with no discoverable panes — is the daemon's to state, and an
 * attachment being open says nothing about whether those are true.
 */
export function statusStripWithAttachment<Strip extends StatusStripCopy>(
  strip: Strip,
  attached: boolean,
): Strip {
  if (!attached || strip.safeState !== NO_ATTACHMENT_SAFE_STATE) return strip;
  return {
    ...strip,
    safeState: ATTACHED_SAFE_STATE,
    nextAction:
      strip.nextAction === NO_ATTACHMENT_NEXT_ACTION ? ATTACHED_NEXT_ACTION : strip.nextAction,
  };
}
