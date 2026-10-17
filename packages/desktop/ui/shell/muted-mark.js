// The small muted bell shown on a muted chat's sidebar row and in its chat header.
const BELL_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17h12l-1.6-2.2V10a4.4 4.4 0 0 0-7.2-3.4M6.6 9.6V14.8L6 17M10.2 20a2 2 0 0 0 3.6 0"/><path d="M4 4l16 16"/></svg>';

/** A `span.<className>` carrying the muted bell, labelled for assistive tech. */
export function mutedMark(className) {
  const mark = document.createElement("span");
  mark.className = className;
  mark.innerHTML = BELL_OFF;
  mark.title = "Notifications muted";
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "Notifications muted");
  return mark;
}
