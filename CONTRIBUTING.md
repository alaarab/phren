# Contributing

## Adding a global skill

1. Create a markdown file in `global/skills/your-skill.md`
2. Follow the existing skill format: name, description, steps
3. Test it locally: run `./link.sh global`, then invoke `/your-skill` in a Claude Code session
4. Open a PR with the skill file and a one-line addition to the skills table in README.md

## PR format

- Title: `skill: add /skill-name` or `fix: description`
- Body: what the skill does, why it's useful, how you tested it

## Skill format

```markdown
# /skill-name

One sentence description.

## Steps

1. What to do first
2. What to do next
3. How to verify it worked
```

Keep skills focused. One skill, one job. If it does two things, make two skills.

## Testing a skill

Link it locally and run it in a real session. Skills are markdown instructions, there's no test runner. The test is: does Claude do the right thing when you invoke it?
