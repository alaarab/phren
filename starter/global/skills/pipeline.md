---
name: pipeline
description: Tell Claude which stage of development you're in and get guidance on what to focus on next.
---
# /pipeline - Where am I in the workflow

Tell Claude which stage of development you're in, and get guidance on what to focus on next.

## Stages

1. **planning** - sketching ideas, designing, deciding what to build
2. **coding** - writing implementation, building features
3. **testing** - running tests, verifying behavior, catching bugs
4. **review** - code review, feedback, making sure it's ready
5. **shipped** - released, deployed, users have it

## What to do

1. Look at recent git commits to understand what's been done recently.
2. Check open files in the editor to see what's actively being worked on.
3. Ask the user: "What stage are you in?" if unclear.
4. Tell the user:
   - **Current stage**: e.g. "You're in the coding stage"
   - **What to focus on next**: e.g. "Once you finish this component, write tests for it. Don't move to review until tests pass."

## Examples

- "You've got 10 failing tests. You're in testing. Run tests again after each fix, don't batch them."
- "You've got code ready but no CHANGELOG entry. That's review stage. Update the changelog, then you're ready to ship."
- "You've got 3 open PRs awaiting feedback. You're in review. Respond to comments or start something new while you wait."

## Customize

- Adjust the stages to match your workflow (you might have a "documentation" or "deployment" stage)
- Add what "done" means for each stage in your project
