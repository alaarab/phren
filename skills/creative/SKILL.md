---
name: creative
description: Design review pass. Does it feel like a person made it, or like AI generated it from a template?
---
# /creative - Make It Feel Real

Look at what was built. Does it feel like a person designed it, or like AI generated it from a template? Elevate the craft.

This isn't about adding features. It's about the difference between "works" and "feels right."

## The Mindset

- **Defaults are the enemy.** If a value looks like it came from a tutorial, question it.
- **Feel > spec.** A 3px difference nobody can name but everyone can feel - that's what this is about.
- **Restraint is creative.** Removing one element is often better than adding three.
- **Motion tells stories.** Static feels dead. Gratuitous animation feels worse. Purposeful motion feels alive.

## What to Look At

### Visual Hierarchy
Does the eye know where to go? Is there a clear focal point, or does everything scream equally?

### Typography
Real type scales have rhythm - not just +2px increments. Check: heading/body contrast, line height (breathing room), letter spacing on caps and small text, intentional weight mixing.

### Spacing
Systematic or random? Related things grouped, unrelated things separated? Generous padding inside containers? An 8px grid with 4px for tight spots keeps things feeling composed.

### Color
Cohesive palette or scattered hex values? Accents used sparingly? Dark mode: actually designed or just filter: invert? Subtle backgrounds and shadows creating layered depth?

### Motion
Hover states that feel responsive (not just "opacity changes"). Transition durations that are intentional: 150ms snappy, 300ms smooth, 500ms+ dramatic. Ease-out curves feel natural, linear feels robotic.

### The Small Stuff
Border radius consistency. Multi-layer shadows for realistic depth. Icons sized relative to their text. Empty states that aren't just "No data." Focus rings that are accessible AND look good.

### Texture
Subtle gradients vs dead flat. Background patterns (grids, dots). Frosted glass where it actually helps. Custom selection colors. Scrollbar styling that matches the theme.

## How to Execute

1. **Audit.** What feels generic? What's already good? Be honest.
2. **Pick 3.** The three highest-impact changes. Not a full redesign.
3. **Reference the best.** Linear, Vercel, Stripe, Raycast, Arc - products where you can feel the craft.
4. **Use CSS variables.** Creative choices should be themeable, not hardcoded.
5. **Both modes.** If it only looks good in light mode, it's not done.
6. **Step back.** One cohesive thing, or a collection of parts?

## Don't

- Gradients on everything
- Animate every scroll event
- Blur effects that tank performance
- Sacrifice readability for aesthetics
- Decorative elements with no purpose
- "Techy" neon grid lines (unless that IS the brand)

## Report

```
/creative - [what was reviewed]

Honest take: [what feels generic, what's already working]

Top 3:
1. [change + why it matters]
2. [change + why it matters]
3. [change + why it matters]

If there's time:
- [stretch idea]
- [stretch idea]

Vibe: [one sentence - where this is heading]
```
